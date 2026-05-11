/**
 * Stop-hook orchestrator — the runtime entry point that wires every prior
 * engine module together through real I/O.
 *
 * Function: runStopHook({ stdin, projectRoot }): Promise<{ exit, stdout, error? }>
 *
 * Inputs:
 *   - stdin: object parsed from the Stop-hook's JSON stdin payload, with
 *            `session_id` and `transcript_path`. Claude Code writes this
 *            object to stdin on every Stop hook invocation.
 *   - projectRoot: absolute path of the user's Claude Code project (cwd
 *            of the user's session). State files live at
 *            `{projectRoot}/.claude/goals/active/`.
 *
 * Returns:
 *   - exit: integer exit code (always 0 — the hook never errors out, since
 *           a Stop-hook crash would surface to the user; we swallow all
 *           internal errors and return null stdout instead).
 *   - stdout: either null (no behavior — pass through) or a Stop-hook
 *           response JSON: `{ decision: 'block', reason, systemMessage }`.
 *           When `decision: 'block'` is returned, Claude Code re-runs the
 *           assistant turn with `reason` injected as the next prompt.
 *   - error: optional string — populated only when an internal error was
 *           caught; useful for `--debug` workflows but never surfaced to
 *           Claude.
 *
 * Behavior gates (in order — each may early-exit with stdout=null):
 *   1. State file missing → no goal active in this project. Return.
 *   2. session_id mismatch — hooks fire on every Claude Code session, but
 *      we only want to drive the session that started the goal. Return.
 *   3. lifecycle === 'paused' → user explicitly paused. Return.
 *   4. (Pursuing path) Increment iteration counter, read transcript, parse
 *      tags, apply mutations, save state.
 *   5. After mutation, if lifecycle transitioned to:
 *        - 'achieved': render prompts/final-summary.md.
 *        - 'unmet':    render prompts/unmet-summary.md (closing summary
 *                      explaining the block).
 *        - other terminal (paused, budget-limited): return.
 *          (achieved/unmet handled above; draft/approved are pre-start
 *          states that don't fire Stop hooks.)
 *   6. Else (still pursuing): pick continuation template based on cursor
 *      status — pursuing → continuation.md, review-pending →
 *      continuation-review.md, blocked → continuation-blocked.md.
 *      Build context, render, append notes digest, return as stdout.
 *
 * Side effects:
 *   - Reads: state.json, tree.json, transcript file, prompts/*.md.
 *   - Writes: tree.json (atomic), state.json (atomic), notes.md (append).
 *   - All writes go to {projectRoot}/.claude/goals/active/.
 *
 * Composition:
 *   - state.mjs: loadState, saveState, loadTree, saveTree.
 *   - transcript.mjs: readLastAssistantText.
 *   - stripCodeRegions(text) — strip ``` fenced blocks and ` inline spans
 *     before parsing, so example tags in prose-rendered prompts don't
 *     trigger spurious mutations.
 *   - parse-tags.mjs: parseTags.
 *   - apply-mutations.mjs: applyMutations.
 *   - continuation.mjs: buildContext, render.
 *   - traversal.mjs: findNodeById.
 *   - paths.mjs: notesPath, activeDir.
 *
 * The plugin root (location of `prompts/`, `engine/`) is resolved via
 * CLAUDE_PLUGIN_ROOT env var (set by Claude Code) or falls back to the
 * directory above `engine/` (so the orchestrator works correctly under
 * `node engine/stop-hook.mjs` invocation in tests).
 */

import fs from 'node:fs';
import path from 'node:path';
import { loadState, loadTree, saveState, saveTree } from './state.mjs';
import { readLastAssistantText, scanAgentInvocations } from './transcript.mjs';
import { parseTags } from './parse-tags.mjs';
import { applyMutations } from './apply-mutations.mjs';
import { appendEvent, appendTurnEvents } from './event-log.mjs';
import { acquireLock, releaseLock, LockTimeoutError } from './lock.mjs';
import { shouldSnapshot, snapshotAndGc } from './snapshots.mjs';
import { randomUUID } from 'node:crypto';
import { findNodeById } from './traversal.mjs';
import { buildContext, render } from './continuation.mjs';
import { notesPath, activeDir, auditsDir } from './paths.mjs';
import { wallclockMinutes } from './wallclock.mjs';
import { tallyTokens, checkLimits } from './budget.mjs';

function readPrompt(name, pluginRoot) {
  return fs.readFileSync(path.join(pluginRoot, 'prompts', name), 'utf8');
}

/**
 * Strip markdown code regions before tag parsing. Fenced blocks (```...```)
 * and inline backtick spans (`...`) contain illustrative example tags from
 * the continuation prompts (e.g., the {{task-status}} examples in
 * prompts/continuation.md:28). Agents paraphrase those prompts in their
 * responses; without stripping, the parser would extract the examples as
 * real tags and trigger spurious mutations.
 *
 * The "canonical" tag-emission convention is: tags appear in the body of
 * the agent's prose, NOT inside backticks/fences. This matches the
 * convention the prompts themselves use.
 */
function stripCodeRegions(text) {
  return text
    .replace(/```[\s\S]*?```/g, '')   // fenced blocks (multiline)
    .replace(/`[^`\n]+`/g, '');       // inline spans (single line)
}

export async function runStopHook({ stdin, projectRoot }) {
  // ADR-0002 lock. The Stop hook holds the per-goal lock for the entire
  // read-decide-write sequence so concurrent CLI scripts (pause/resume/etc.)
  // wait for our turn to finish before mutating state. On contention we
  // return null stdout with a stderr diagnostic — Claude Code interprets as
  // "no continuation prompt", which is the correct outcome when another
  // process is mid-mutation. (A 5s wait would unnecessarily block the user's
  // chat.)
  let lockHandle = null;
  try {
    lockHandle = await acquireLock(activeDir(projectRoot), 'stop-hook-tick', {
      sessionId: stdin?.session_id,
      timeoutMs: 5000,
    });
  } catch (err) {
    if (err instanceof LockTimeoutError) {
      process.stderr.write(
        `[goal-mode] Stop-hook lock contention: ${err.message}. Skipping this turn — another process is mid-mutation. Will retry on next user turn.\n`,
      );
      return { exit: 0, stdout: null, error: err.message };
    }
    throw err;
  }
  try {
    // PLUGIN_ROOT is resolved at runtime (not module-load time) so tests can
    // override CLAUDE_PLUGIN_ROOT after importing this module. In production,
    // Claude Code spawns a fresh CLI per Stop hook so module-level capture
    // would also work — but runtime resolution is strictly more general.
    const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT
      ?? path.resolve(new URL('..', import.meta.url).pathname);

    const state = loadState(projectRoot);
    if (!state) return { exit: 0, stdout: null };
    // Session-id matching with auto-rebind:
    //
    //   A live Stop-hook arrives only from a live Claude session. If
    //   state.session_id points elsewhere AND lifecycle === 'pursuing',
    //   the prior session is presumed closed/compacted — auto-rebind to
    //   the live session so users don't have to jq-patch state.json after
    //   every /compact or new-session-on-same-project.
    //
    //   Anti-flap guard: if state.session_id was itself rebound in the
    //   last 5 history entries, two parallel sessions are fighting over
    //   the same goal — refuse to flip-flop and emit stderr so the
    //   user knows to pause one with /goal-mode:goal-pause.
    //
    //   Paused goals: never auto-rebind. The user explicitly paused, so
    //   we honour that and pass through silently.
    if (stdin.session_id && state.session_id !== stdin.session_id) {
      if (state.lifecycle !== 'pursuing') {
        // Paused / achieved / unmet / budget-limited — pass through.
        return { exit: 0, stdout: null };
      }
      // Anti-flap heuristic: trigger ONLY when there's strong evidence that
      // two parallel sessions are fighting — not after any single legitimate
      // rebind. Two signals together must be true:
      //
      //   (a) The most recent rebound event in state.history happened within
      //       the last 60 seconds. A long-ago rebound (e.g., yesterday's
      //       /compact) is not a flap — the prior session is dead by now.
      //   (b) That rebound's new_session_id equals the current state.session_id
      //       AND was rebound FROM the session id that's now firing the Stop
      //       hook. That's the actual ping-pong pattern: A→B then immediately B→A.
      //
      // A single recent rebind from session X to session Y, followed minutes
      // later by Stop hook from session Z (different from both), is normal —
      // user closed X, opened Y briefly, closed Y, opened Z. Auto-rebind to Z.
      const lastRebind = [...(state.history ?? [])]
        .reverse()
        .find((e) => e?.event === 'session-rebound');
      const FLAP_WINDOW_MS = 60_000;
      const lastRebindAgeMs = lastRebind?.ts
        ? Date.now() - new Date(lastRebind.ts).getTime()
        : Infinity;
      const isPingPong = lastRebind
        && lastRebind.payload?.new_session_id === state.session_id
        && lastRebind.payload?.old_session_id === stdin.session_id;
      if (isPingPong && lastRebindAgeMs < FLAP_WINDOW_MS) {
        process.stderr.write(
          `[goal-mode] Stop-hook anti-flap: state.session_id="${state.session_id}" was rebound to `
          + `from "${stdin.session_id}" ${Math.round(lastRebindAgeMs / 1000)}s ago; refusing to ping-pong back. `
          + `Two parallel Claude sessions appear to be sharing this goal. Pause one with `
          + `/goal-mode:goal-pause, or jq-patch state.json to the session you want to drive.\n`,
        );
        return { exit: 0, stdout: null };
      }
      const oldId = state.session_id;
      const rebindTs = new Date().toISOString();
      state.session_id = stdin.session_id;
      state.history.push({
        ts: rebindTs,
        iteration: state.budget.iterations.used,
        event: 'session-rebound',
        node_id: state.cursor,
        payload: {
          old_session_id: oldId,
          new_session_id: stdin.session_id,
          reason: 'live Stop hook from new session while lifecycle=pursuing; prior session presumed closed/compacted',
        },
      });
      saveState(projectRoot, state);
      process.stderr.write(
        `[goal-mode] Stop-hook session rebind: state.session_id "${oldId}" → "${stdin.session_id}" `
        + `(prior session closed/compacted; lifecycle=pursuing). `
        + `To prevent auto-rebind, pause the goal with /goal-mode:goal-pause.\n`,
      );
      // Fall through to normal pursuing path.
    }
    if (state.lifecycle !== 'pursuing') return { exit: 0, stdout: null };

    const tree = loadTree(projectRoot);
    if (!tree) return { exit: 0, stdout: null };

    state.budget.iterations.used += 1;
    state.budget.tokens.used = tallyTokens(stdin.transcript_path);

    const limitHit = checkLimits(state.budget);
    if (limitHit) {
      const ts = new Date().toISOString();
      state.lifecycle = 'budget-limited';
      state.ended_at = ts;
      state.ended_reason = `${limitHit} budget exhausted`;
      state.history.push({
        ts,
        iteration: state.budget.iterations.used,
        event: 'budget-exhausted',
        node_id: state.cursor,
        payload: { kind: limitHit },
      });
      saveState(projectRoot, state);

      const tpl = readPrompt('budget-limit.md', PLUGIN_ROOT);
      const ctx = {
        limit_kind: limitHit,
        iterations_used: state.budget.iterations.used,
        iterations_max: state.budget.iterations.max,
        tokens_used: state.budget.tokens.used,
        tokens_max: state.budget.tokens.max,
        wallclock_minutes: wallclockMinutes(state),
        wallclock_max_minutes: Math.floor(state.budget.wallclock.max_seconds / 60),
        ts,
      };
      return {
        exit: 0,
        stdout: {
          decision: 'block',
          reason: render(tpl, ctx),
          systemMessage: `🟡 ${limitHit} budget exhausted`,
        },
      };
    }

    const lastText = readLastAssistantText(stdin.transcript_path);
    const scopedText = stripCodeRegions(lastText);
    const tags = parseTags(scopedText);
    const ts = new Date().toISOString();

    // Reviewer-independence: scan the transcript for Agent tool_use blocks
    // since the last cursor-advanced event for the current cursor. Pass the
    // resulting subagent_type Set to applyMutations so audit-verdict tags
    // for agents we did NOT see dispatched get rejected with a history
    // entry instead of silently advancing the cursor.
    const lastCursorAdvance = [...state.history]
      .reverse()
      .find((e) => e.event === 'cursor-advanced' && e.node_id === state.cursor);
    const sinceTs = lastCursorAdvance?.ts ?? state.started_at ?? null;
    const scannedAgents = scanAgentInvocations(stdin.transcript_path, sinceTs);

    const { tree: newTree, state: newState, history: turnHistory } = applyMutations(tree, state, tags, ts, {
      auditsDir: auditsDir(projectRoot),
      scannedAgents,
    });

    // Dual-write: in addition to state.history (the v1 path), append every
    // mutation as an event-log entry. The event log is the future source of
    // truth (v1.2.0 introduces it as parallel; a later major migration can
    // collapse to events-only). See engine/event-log.mjs and
    // engine/state-from-events.mjs for replay semantics.
    //
    // Order: events first, state.json second. Crash between → events.jsonl
    // is authoritative truth, recovery via replayEvents reconstructs state.
    // (v1.2.0 wrote state first, leaving events stale on crash.)
    // Per ADR-0001 §Event taxonomy + Phase 4 dual-write rc1: emit one
    // turn-grouped event batch per Stop-hook fire. All events from this turn
    // share a single `turn_id` and consecutive `seq` values; a single
    // `appendFileSync` call gives POSIX-atomic visibility at the OS level.
    //
    // Order: events first, state.json second. A crash between leaves
    // events.jsonl authoritative; recovery via reducer replay reconstructs.
    // Per ADR-0001 §Snapshot policy: snapshot is taken after the events land
    // when `shouldSnapshot(turnEvents, before, after)` is true.
    let turnEventsForSnapshot = [];
    let seqAfter = -1;
    try {
      const turnId = randomUUID();
      const turnEvents = buildTurnEventPartials(newState, turnHistory, ts);
      if (turnEvents.length > 0) {
        const emitted = appendTurnEvents(projectRoot, turnId, turnEvents);
        turnEventsForSnapshot = emitted;
        seqAfter = emitted[emitted.length - 1].seq;
      }
    } catch (err) {
      // Event-log write failures must NOT block engine forward progress.
      // The v1 path (state.history) is still authoritative until rc2.
      process.stderr.write(`[goal-mode] event-log append failed (non-fatal): ${err.message}\n`);
    }

    saveTree(projectRoot, newTree);
    saveState(projectRoot, newState);

    // Take a snapshot when the trigger policy says so (cursor-advanced, or
    // boundary crossing). Snapshot is post-state-save so the cached state
    // matches the snapshot — replay self-validates on next load. Best-effort
    // (non-fatal failure logged to stderr).
    try {
      if (turnEventsForSnapshot.length > 0) {
        const seqBefore = turnEventsForSnapshot[0].seq - 1;
        if (shouldSnapshot(turnEventsForSnapshot, seqBefore, seqAfter)) {
          snapshotAndGc(projectRoot, seqAfter, newState, newTree);
        }
      }
    } catch (err) {
      process.stderr.write(`[goal-mode] snapshot failed (non-fatal): ${err.message}\n`);
    }

    // Append iteration digest BEFORE lifecycle branching, so terminal turns
    // (achieved/unmet) are also logged. Cursor may not exist post-mutation
    // (e.g., advanced past the last node) — appendNotesDigest handles that.
    const postCursor = findNodeById(newTree, newState.cursor);
    appendNotesDigest(projectRoot, newState, postCursor, ts);

    if (newState.lifecycle === 'achieved') {
      const tpl = readPrompt('final-summary.md', PLUGIN_ROOT);
      const ctx = buildSummaryContext(newTree, newState, ts);
      const reason = render(tpl, ctx);
      return { exit: 0, stdout: { decision: 'block', reason, systemMessage: '✅ goal achieved' } };
    }

    if (newState.lifecycle === 'unmet') {
      const tpl = readPrompt('unmet-summary.md', PLUGIN_ROOT);
      const ctx = buildUnmetContext(newTree, newState, ts);
      const reason = render(tpl, ctx);
      return { exit: 0, stdout: { decision: 'block', reason, systemMessage: '🔴 goal unmet' } };
    }

    if (newState.lifecycle !== 'pursuing') {
      return { exit: 0, stdout: null };
    }

    const cursor = findNodeById(newTree, newState.cursor);
    if (!cursor) {
      console.error(`[goal-mode] cursor ${newState.cursor} not found in tree; skipping continuation render`);
      return { exit: 0, stdout: null, error: `cursor ${newState.cursor} not found in tree` };
    }

    let templateName = 'continuation.md';
    if (cursor.status === 'review-pending') templateName = 'continuation-review.md';
    else if (cursor.status === 'blocked') templateName = 'continuation-blocked.md';

    const ctx = buildContext(newTree, newState, newState.cursor);
    if (!ctx) {
      console.error(`[goal-mode] buildContext returned null for cursor ${newState.cursor}`);
      return { exit: 0, stdout: null, error: `buildContext returned null` };
    }
    if (templateName === 'continuation-review.md') {
      ctx.audit_instructions = render(readPrompt('audit-instructions.md', PLUGIN_ROOT), ctx);
      // Surface rejected verdicts from this review cycle so the agent SEES
      // that a previous verdict was discarded for missing Agent dispatch.
      // Without this, agent re-emits the same fabricated GO and the cursor
      // never advances (the "invisible rejection → infinite loop" bug from
      // v1.2.0 critique A4).
      const lastCursorAdvanceTs = [...newState.history]
        .reverse()
        .find((e) => e.event === 'cursor-advanced' && e.node_id === cursor.id)?.ts
        ?? newState.started_at;
      ctx.rejected_verdicts = newState.history
        .filter(
          (h) => h.event === 'review-verdict'
            && h.node_id === cursor.id
            && h.payload?.rejected === true
            && (!lastCursorAdvanceTs || h.ts >= lastCursorAdvanceTs),
        )
        .map((h) => ({ agent: h.payload.agent, status: h.payload.status, reason: h.payload.reason ?? 'unknown' }));
      ctx.has_rejected_verdicts = ctx.rejected_verdicts.length > 0;
    }
    if (templateName === 'continuation-blocked.md') {
      const uncovered = ctx.criteria.filter(c => c.covered_marker === ' ');
      ctx.uncovered_criteria = uncovered;
      ctx.last_verdicts = newState.history
        .filter(h => h.event === 'review-verdict' && h.node_id === cursor.id)
        .slice(-(cursor.review.length || 1))
        .map(h => ({ agent: h.payload.agent, status: h.payload.status, text: h.payload.text }));
      // v2.0.1 hotfix: when blocker came from an escape-hatch verdict
      // (reviewer subagent_type unavailable in environment), surface the
      // distinct recovery flow (/goal-approve OR register agent OR revise
      // plan) instead of the generic "address the verdicts and retry"
      // template. Detect via the most recent node-blocked event carrying
      // payload.escape_hatch=true.
      const lastBlocked = [...newState.history]
        .reverse()
        .find((e) => e.event === 'node-blocked' && e.node_id === cursor.id);
      if (lastBlocked?.payload?.escape_hatch === true) {
        // Walk back from lastBlocked to collect the escape-hatch verdicts
        // emitted in the same turn (same iteration, escape_hatch=true).
        const escapeVerdicts = newState.history.filter((h) =>
          h.event === 'review-verdict'
          && h.node_id === cursor.id
          && h.payload?.escape_hatch === true
          && h.iteration === lastBlocked.iteration,
        );
        const agents = [...new Set(escapeVerdicts.map((h) => h.payload.agent))];
        if (agents.length > 0) {
          ctx.unavailable_reviewers = agents.map((a) => ({ agent: a }));
          ctx.unavailable_reviewers_csv = agents.join(', ');
        }
      }
    }

    const rendered = render(readPrompt(templateName, PLUGIN_ROOT), ctx);

    return {
      exit: 0,
      stdout: {
        decision: 'block',
        reason: rendered,
        systemMessage: `🎯 ${cursor.id} | it: ${newState.budget.iterations.used}/${newState.budget.iterations.max} | tok: ${newState.budget.tokens.used}/${newState.budget.tokens.max}`,
      },
    };
  } catch (err) {
    // Visibility-first error handling. The previous "swallow + return null"
    // behavior caused the conversation to silently stall whenever any internal
    // step threw (zod schema validation, template render, applyMutations,
    // saveState/saveTree, transcript parse). The user just saw "engine
    // встал" with no diagnostic in the conversation flow — stderr in Desktop
    // hooks is not visible in the chat UI.
    //
    // SOTA contract: an internal error MUST surface as a block-decision
    // continuation prompt so the assistant sees it on the next turn and can
    // react (e.g., revert a bad state.json edit, fix a malformed tag, file
    // a bug). The error message + stack are included so the assistant has
    // enough context to recover without an opaque "пощупай в потёмках" loop.
    const errMsg = String(err?.message ?? err);
    const errStack = err?.stack ? `\n\nStack:\n${err.stack}` : '';
    console.error(`[goal-mode] runStopHook caught error: ${errMsg}`, err?.stack);
    const reason = [
      '⚠️ goal-mode engine error',
      '',
      'The Stop-hook engine caught an internal error while processing this turn.',
      'No state mutations were saved (or only partial — check .claude/goals/active/state.json).',
      '',
      `Error: ${errMsg}`,
      errStack,
      '',
      'Recovery hints:',
      '- If you recently hand-edited state.json or tree.json, the edit may have',
      '  violated the zod schema (e.g., unknown event in history.event, missing',
      '  required field). Run `jq . .claude/goals/active/state.json` to validate JSON,',
      '  then compare against engine/state.mjs schema definitions.',
      '- If a template render failed, the template variable may be undefined —',
      '  check prompts/ directory for the failing variable name.',
      '- If applyMutations failed, the last assistant tags may have malformed',
      '  attribute values — inspect the last assistant message for tag syntax.',
      '',
      'Report this with the error + stack if reproducible. Do NOT re-attempt',
      'the same operation blindly — fix the root cause first.',
    ].join('\n');
    return {
      exit: 0,
      stdout: {
        decision: 'block',
        reason,
        systemMessage: `⚠️ goal-mode engine error: ${errMsg.slice(0, 100)}`,
      },
      error: errMsg,
    };
  } finally {
    if (lockHandle) releaseLock(lockHandle);
  }
}

function buildSummaryContext(tree, state, ts) {
  function counts(node, acc = { sprint: 0, epic: 0, task: 0 }) {
    acc[node.type] = (acc[node.type] ?? 0) + 1;
    for (const c of node.children) counts(c, acc);
    return acc;
  }
  const c = counts(tree.root);
  return {
    iterations_used: state.budget.iterations.used,
    tokens_used: state.budget.tokens.used,
    wallclock_minutes: wallclockMinutes(state),
    sprint_count: c.sprint,
    epic_count: c.epic,
    task_count: c.task,
    audit_count: state.history.filter(h => h.event === 'review-verdict').length,
    ts,
  };
}

function buildUnmetContext(tree, state, ts) {
  // The blocking node is the cursor at the time unmet fired.
  const cursor = findNodeById(tree, state.cursor);
  function counts(node, acc = { achieved: 0, total: 0 }) {
    if (node.type === 'task') {
      acc.total += 1;
      if (node.status === 'achieved') acc.achieved += 1;
    }
    for (const c of node.children) counts(c, acc);
    return acc;
  }
  const c = counts(tree.root);
  return {
    blocked_task_id: cursor?.id ?? state.cursor,
    blocked_task_title: cursor?.title ?? '(unknown)',
    blocker_reason: cursor?.blocker_reason ?? '(no reason recorded)',
    review_attempts: cursor?.review_attempts ?? 0,
    iterations_used: state.budget.iterations.used,
    tokens_used: state.budget.tokens.used,
    wallclock_minutes: wallclockMinutes(state),
    tasks_achieved: c.achieved,
    tasks_total: c.total,
    ts,
  };
}

function appendNotesDigest(projectRoot, state, cursor, ts) {
  fs.mkdirSync(activeDir(projectRoot), { recursive: true });
  const cursorInfo = cursor
    ? `cursor ${cursor.id} status=${cursor.status} evidence=${cursor.evidence.length}`
    : `cursor ${state.cursor} (not found in tree)`;
  const lifecycleInfo = state.lifecycle === 'pursuing' ? '' : ` lifecycle=${state.lifecycle}`;
  const line = `- ${ts} iter ${state.budget.iterations.used}: ${cursorInfo}${lifecycleInfo}\n`;
  fs.appendFileSync(notesPath(projectRoot), line);
}

/**
 * Map a state.history entry to an event-log entry kind and append it.
 * The mapping is intentionally narrow: history events that have a structural
 * meaning (state changed) become event-log entries; informational history
 * entries do not. Replay (state-from-events) uses these to reconstruct state.
 */
/**
 * Convert this turn's mutations into an ordered array of event partials.
 * Used by Phase 4 dual-write: callers pass to `appendTurnEvents` for a
 * single atomic batch.
 *
 * Ordering matters for replay determinism: budget-tally first (counters),
 * then per-history-entry events in the order they fired in applyMutations.
 */
function buildTurnEventPartials(newState, turnHistory, ts) {
  const goalId = newState.goal_id;
  const wallclockElapsedSec = Math.floor(
    (Date.now() - new Date(newState.budget.wallclock.started_at).getTime()) / 1000,
  );
  const partials = [];
  // Budget-tally always emitted (per-turn cumulative counters).
  partials.push({
    ts,
    goal_id: goalId,
    kind: 'budget-tally',
    payload: {
      iterations: { used: newState.budget.iterations.used, max: newState.budget.iterations.max },
      tokens: { used: newState.budget.tokens.used, max: newState.budget.tokens.max },
      wallclock: {
        elapsed_seconds: wallclockElapsedSec,
        max_seconds: newState.budget.wallclock.max_seconds,
      },
    },
  });
  for (const h of turnHistory) {
    const ev = historyToEventPartial(h, goalId);
    if (ev) partials.push(ev);
  }
  return partials;
}

function historyToEventPartial(h, goalId) {
  if (h.event === 'evidence-added') {
    return {
      ts: h.ts, goal_id: goalId, kind: 'evidence-added',
      payload: {
        cursor: h.node_id ?? h.payload?.cursor ?? 'unknown',
        criterion_index: h.payload?.criterion ?? null,
        file: h.payload?.file ?? null,
        command: h.payload?.command ?? null,
        note: h.payload?.note ?? 'recorded from history',
      },
    };
  }
  if (h.event === 'cursor-advanced') {
    return {
      ts: h.ts, goal_id: goalId, kind: 'cursor-advanced',
      payload: {
        from: h.payload?.from ?? h.node_id ?? 'unknown',
        to: h.payload?.to ?? h.node_id ?? 'unknown',
        reason: h.payload?.reason === 'review-go' ? 'review-go'
              : h.payload?.from === 'manual-approve' ? 'manual-approve'
              : 'achieved',
      },
    };
  }
  if (h.event === 'node-blocked') {
    return {
      ts: h.ts, goal_id: goalId, kind: 'node-blocked',
      payload: {
        cursor: h.node_id ?? 'unknown',
        reason: h.payload?.reason ?? 'no reason recorded',
        review_attempts: h.payload?.review_attempts ?? 0,
      },
    };
  }
  if (h.event === 'review-requested') {
    return {
      ts: h.ts, goal_id: goalId, kind: 'review-requested',
      payload: { cursor: h.node_id ?? 'unknown', agents: h.payload?.agents ?? [] },
    };
  }
  if (h.event === 'review-verdict') {
    return {
      ts: h.ts, goal_id: goalId, kind: 'audit-verdict-received',
      payload: {
        cursor: h.node_id ?? 'unknown',
        agent: h.payload?.agent ?? 'unknown',
        status: h.payload?.status ?? 'NOGO',
        text: h.payload?.text ?? '',
        rejected: h.payload?.rejected ?? false,
        reason: h.payload?.reason,
      },
    };
  }
  if (h.event === 'achieved' || h.event === 'unmet') {
    return {
      ts: h.ts, goal_id: goalId, kind: 'lifecycle-changed',
      payload: { from: 'pursuing', to: h.event, reason: h.payload?.reason ?? null },
    };
  }
  if (h.event === 'budget-exhausted') {
    return {
      ts: h.ts, goal_id: goalId, kind: 'budget-exhausted',
      payload: {
        which: h.payload?.kind ?? 'iterations',
        used: h.payload?.used ?? 0,
        max: h.payload?.max ?? 0,
      },
    };
  }
  return null;
}

// Legacy single-event emitter (used by tests + non-stop-hook paths). Phase 4
// stop-hook now uses appendTurnEvents directly via buildTurnEventPartials.
function emitEventForHistoryEntry(projectRoot, h, goalId) {
  // Map state.history events to ADR-0001 §Event taxonomy kinds + correct
  // payload shape. Some history events have no event-log equivalent
  // (informational digest, session-rebound which is an internal engine
  // concept) — those return early.
  if (h.event === 'evidence-added') {
    appendEvent(projectRoot, {
      ts: h.ts, goal_id: goalId, kind: 'evidence-added',
      payload: {
        cursor: h.node_id ?? h.payload?.cursor ?? 'unknown',
        criterion_index: h.payload?.criterion ?? null,
        file: h.payload?.file ?? null,
        command: h.payload?.command ?? null,
        note: h.payload?.note ?? 'recorded from history',
      },
    });
    return;
  }
  if (h.event === 'cursor-advanced') {
    appendEvent(projectRoot, {
      ts: h.ts, goal_id: goalId, kind: 'cursor-advanced',
      payload: {
        from: h.payload?.from ?? h.node_id ?? 'unknown',
        to: h.payload?.to ?? h.node_id ?? 'unknown',
        reason: h.payload?.reason === 'review-go' ? 'review-go'
              : h.payload?.from === 'manual-approve' ? 'manual-approve'
              : 'achieved',
      },
    });
    return;
  }
  if (h.event === 'node-blocked') {
    appendEvent(projectRoot, {
      ts: h.ts, goal_id: goalId, kind: 'node-blocked',
      payload: {
        cursor: h.node_id ?? 'unknown',
        reason: h.payload?.reason ?? 'no reason recorded',
        review_attempts: h.payload?.review_attempts ?? 0,
      },
    });
    return;
  }
  if (h.event === 'review-requested') {
    appendEvent(projectRoot, {
      ts: h.ts, goal_id: goalId, kind: 'review-requested',
      payload: { cursor: h.node_id ?? 'unknown', agents: h.payload?.agents ?? [] },
    });
    return;
  }
  if (h.event === 'review-verdict') {
    appendEvent(projectRoot, {
      ts: h.ts, goal_id: goalId, kind: 'audit-verdict-received',
      payload: {
        cursor: h.node_id ?? 'unknown',
        agent: h.payload?.agent ?? 'unknown',
        status: h.payload?.status ?? 'NOGO',
        text: h.payload?.text ?? '',
        rejected: h.payload?.rejected ?? false,
        reason: h.payload?.reason,
      },
    });
    return;
  }
  if (h.event === 'achieved' || h.event === 'unmet') {
    appendEvent(projectRoot, {
      ts: h.ts, goal_id: goalId, kind: 'lifecycle-changed',
      payload: { from: 'pursuing', to: h.event, reason: h.payload?.reason ?? null },
    });
    return;
  }
  if (h.event === 'budget-exhausted') {
    appendEvent(projectRoot, {
      ts: h.ts, goal_id: goalId, kind: 'budget-exhausted',
      payload: {
        which: h.payload?.kind ?? 'iterations',
        used: h.payload?.used ?? 0,
        max: h.payload?.max ?? 0,
      },
    });
    return;
  }
  // session-rebound, budget-warning, evidence-required etc — no spec event
  // kind; pass through as state.history only.
}
