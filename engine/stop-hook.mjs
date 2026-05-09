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
 *        - other terminal (paused, cancelled, budget-limited): return.
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
import { readLastAssistantText } from './transcript.mjs';
import { parseTags } from './parse-tags.mjs';
import { applyMutations } from './apply-mutations.mjs';
import { findNodeById } from './traversal.mjs';
import { buildContext, render } from './continuation.mjs';
import { notesPath, activeDir } from './paths.mjs';

const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT
  ?? path.resolve(new URL('..', import.meta.url).pathname);

function readPrompt(name) {
  return fs.readFileSync(path.join(PLUGIN_ROOT, 'prompts', name), 'utf8');
}

export async function runStopHook({ stdin, projectRoot }) {
  try {
    const state = loadState(projectRoot);
    if (!state) return { exit: 0, stdout: null };
    if (state.session_id !== stdin.session_id) return { exit: 0, stdout: null };
    if (state.lifecycle !== 'pursuing') return { exit: 0, stdout: null };

    const tree = loadTree(projectRoot);
    if (!tree) return { exit: 0, stdout: null };

    state.budget.iterations.used += 1;

    const lastText = readLastAssistantText(stdin.transcript_path);
    const tags = parseTags(lastText);
    const ts = new Date().toISOString();
    const { tree: newTree, state: newState } = applyMutations(tree, state, tags, ts);

    saveTree(projectRoot, newTree);
    saveState(projectRoot, newState);

    if (newState.lifecycle === 'achieved') {
      const tpl = readPrompt('final-summary.md');
      const ctx = buildSummaryContext(newTree, newState, ts);
      const reason = render(tpl, ctx);
      return { exit: 0, stdout: { decision: 'block', reason, systemMessage: '✅ goal achieved' } };
    }

    if (newState.lifecycle === 'unmet') {
      const tpl = readPrompt('unmet-summary.md');
      const ctx = buildUnmetContext(newTree, newState, ts);
      const reason = render(tpl, ctx);
      return { exit: 0, stdout: { decision: 'block', reason, systemMessage: '🔴 goal unmet' } };
    }

    if (newState.lifecycle !== 'pursuing') {
      return { exit: 0, stdout: null };
    }

    const cursor = findNodeById(newTree, newState.cursor);
    let templateName = 'continuation.md';
    if (cursor.status === 'review-pending') templateName = 'continuation-review.md';
    else if (cursor.status === 'blocked') templateName = 'continuation-blocked.md';

    const ctx = buildContext(newTree, newState, newState.cursor);
    if (templateName === 'continuation-review.md') {
      ctx.audit_instructions = render(readPrompt('audit-instructions.md'), ctx);
    }
    if (templateName === 'continuation-blocked.md') {
      const uncovered = ctx.criteria.filter(c => c.covered_marker === ' ');
      ctx.uncovered_criteria = uncovered;
      ctx.last_verdicts = newState.history
        .filter(h => h.event === 'review-verdict' && h.node_id === cursor.id)
        .slice(-(cursor.review.length || 1))
        .map(h => ({ agent: h.payload.agent, status: h.payload.status, text: h.payload.text }));
    }

    const rendered = render(readPrompt(templateName), ctx);
    appendNotesDigest(projectRoot, newState, cursor, ts);

    return {
      exit: 0,
      stdout: {
        decision: 'block',
        reason: rendered,
        systemMessage: `🎯 ${cursor.id} | it: ${newState.budget.iterations.used}/${newState.budget.iterations.max} | tok: ${newState.budget.tokens.used}/${newState.budget.tokens.max}`,
      },
    };
  } catch (err) {
    return { exit: 0, stdout: null, error: String(err) };
  }
}

function buildSummaryContext(tree, state, ts) {
  function counts(node, acc = { sprint: 0, epic: 0, task: 0 }) {
    acc[node.type] = (acc[node.type] ?? 0) + 1;
    for (const c of node.children) counts(c, acc);
    return acc;
  }
  const c = counts(tree.root);
  const wallStart = new Date(state.budget.wallclock.started_at).getTime();
  return {
    iterations_used: state.budget.iterations.used,
    tokens_used: state.budget.tokens.used,
    wallclock_minutes: Math.max(0, Math.floor((Date.now() - wallStart) / 60000)),
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
  const wallStart = new Date(state.budget.wallclock.started_at).getTime();
  return {
    blocked_task_id: cursor?.id ?? state.cursor,
    blocked_task_title: cursor?.title ?? '(unknown)',
    blocker_reason: cursor?.blocker_reason ?? '(no reason recorded)',
    review_attempts: cursor?.review_attempts ?? 0,
    iterations_used: state.budget.iterations.used,
    tokens_used: state.budget.tokens.used,
    wallclock_minutes: Math.max(0, Math.floor((Date.now() - wallStart) / 60000)),
    tasks_achieved: c.achieved,
    tasks_total: c.total,
    ts,
  };
}

function appendNotesDigest(projectRoot, state, cursor, ts) {
  fs.mkdirSync(activeDir(projectRoot), { recursive: true });
  const line = `- ${ts} iter ${state.budget.iterations.used}: cursor ${cursor.id} status=${cursor.status} evidence=${cursor.evidence.length}\n`;
  fs.appendFileSync(notesPath(projectRoot), line);
}
