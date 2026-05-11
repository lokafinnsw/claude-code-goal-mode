/**
 * Shared hook-context plumbing — used by BOTH Stop and SessionStart hooks.
 *
 * Why this module exists:
 *   Pre-v2.0.3 the Stop hook enriched its render context (audit_instructions,
 *   rejected_verdicts, has_rejected_verdicts, uncovered_criteria, last_verdicts,
 *   unavailable_reviewers, unavailable_reviewers_csv) inline. SessionStart only
 *   called `buildContext` and passed the bare context to the render. When the
 *   cursor was in review-pending or blocked state at the time SessionStart
 *   fired, the rendered prompt referenced `{{audit_instructions}}`,
 *   `{{rejected_verdicts}}`, `{{unavailable_reviewers_csv}}` etc. as
 *   undefined — leaving empty sections or (depending on render impl) literal
 *   `{{...}}` placeholders for the user to read. This is bug C1 from the
 *   2026-05-11 audit.
 *
 *   `enrichContinuationContext` is the single source of truth for this
 *   enrichment. Both hooks call it after `buildContext`.
 *
 *   `hasActiveGoal` is the fast precheck that lets the Stop hook skip lock
 *   acquisition (and the `.claude/goals/active/` directory creation that
 *   `acquireLock` does via `fs.mkdirSync(goalDir, { recursive: true })`) when
 *   there is no goal in this project. Without it (bug C2 from the audit),
 *   every Stop-hook fire on every project the user touches creates an empty
 *   `.claude/goals/active/` directory, polluting the filesystem.
 *
 * Pure: enrichContinuationContext is read-only (mutates the passed ctx
 * object, returns it). hasActiveGoal does a single statSync.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { statePath, treePath } from './paths.mjs';
import { render } from './continuation.mjs';

/**
 * Resolve the plugin root from CLAUDE_PLUGIN_ROOT or, in tests / direct
 * Node invocations, from this file's location. Uses fileURLToPath instead
 * of `new URL().pathname` so the path is Windows-correct (pathname there
 * has a leading slash before drive letters: `/C:/path/...`). Bug I1 fix.
 */
export function resolvePluginRoot(importMetaUrl) {
  if (process.env.CLAUDE_PLUGIN_ROOT) return process.env.CLAUDE_PLUGIN_ROOT;
  return path.resolve(path.dirname(fileURLToPath(importMetaUrl)), '..');
}

/**
 * Read a prompt template from <pluginRoot>/prompts/<name>. Throws on
 * missing file — callers should let that bubble to the hook's outer
 * try/catch so the user sees an engine-error continuation prompt.
 */
export function readPromptFile(name, pluginRoot) {
  return fs.readFileSync(path.join(pluginRoot, 'prompts', name), 'utf8');
}

/**
 * Fast precheck: does this project have an active goal at all?
 *
 * Returns true iff `<projectRoot>/.claude/goals/active/state.json` exists.
 * Callers that gate lock acquisition on this avoid bug C2 (every Stop-hook
 * fire on every project creates `.claude/goals/active/` as a side effect of
 * lock acquisition's mkdirSync).
 *
 * Intentionally does NOT validate the state.json schema — that's the
 * `loadState` job, which the caller will do AFTER acquiring the lock. We
 * just need a cheap existence check here.
 */
export function hasActiveGoal(projectRoot) {
  try {
    return fs.statSync(statePath(projectRoot)).isFile();
  } catch {
    return false;
  }
}

/**
 * Same as hasActiveGoal but also verifies tree.json exists. Used when the
 * caller needs both files to proceed (e.g., a render that walks the tree).
 */
export function hasActiveGoalAndTree(projectRoot) {
  if (!hasActiveGoal(projectRoot)) return false;
  try {
    return fs.statSync(treePath(projectRoot)).isFile();
  } catch {
    return false;
  }
}

/**
 * Enrich a buildContext-produced ctx object with the template-specific
 * fields that the review/blocked continuation prompts require.
 *
 * @param ctx the bare ctx from buildContext (mutated in place AND returned)
 * @param templateName one of 'continuation.md' / 'continuation-review.md' /
 *   'continuation-blocked.md'. Determines which fields are added.
 * @param newState the goal state at render time (used to walk history).
 * @param cursor the cursor node (used to detect escape-hatch reason in
 *   blocker_reason as a rotation-resilient fallback — bug I4 fix).
 * @param opts.pluginRoot used to read audit-instructions.md for review template.
 */
export function enrichContinuationContext(ctx, templateName, newState, cursor, opts = {}) {
  const { pluginRoot } = opts;
  if (templateName === 'continuation-review.md') {
    if (pluginRoot) {
      ctx.audit_instructions = render(readPromptFile('audit-instructions.md', pluginRoot), ctx);
    }
    // Surface rejected verdicts since the last cursor advancement for this
    // cursor (so the agent sees that a prior verdict was discarded for
    // missing Agent dispatch and re-dispatches before re-emitting). Without
    // this, agent re-emits the same fabricated GO and the cursor never
    // advances (the "invisible rejection → infinite loop" bug from
    // v1.2.0 critique A4).
    const lastCursorAdvanceTs = [...(newState.history ?? [])]
      .reverse()
      .find((e) => e.event === 'cursor-advanced' && e.node_id === cursor.id)?.ts
      ?? newState.started_at;
    ctx.rejected_verdicts = (newState.history ?? [])
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
    const uncovered = (ctx.criteria ?? []).filter((c) => c.covered_marker === ' ');
    ctx.uncovered_criteria = uncovered;
    // Deduplicate last_verdicts by (agent, status, text) — bug M5 fix.
    // Without it, when the same agent emits multiple verdicts before the
    // cursor advances, the user sees repeated lines.
    const verdictsBuf = (newState.history ?? [])
      .filter((h) => h.event === 'review-verdict' && h.node_id === cursor.id)
      .slice(-(cursor.review.length || 1));
    const seenKey = new Set();
    ctx.last_verdicts = [];
    for (const h of verdictsBuf) {
      const key = `${h.payload.agent}|${h.payload.status}|${(h.payload.text ?? '').trim()}`;
      if (seenKey.has(key)) continue;
      seenKey.add(key);
      ctx.last_verdicts.push({ agent: h.payload.agent, status: h.payload.status, text: h.payload.text });
    }

    // Escape-hatch surfacing (bug I4 fix — robust to history rotation).
    // Primary detection: walk history for the most recent node-blocked event
    // with payload.escape_hatch=true, and collect the escape-hatch verdicts
    // emitted in the same iteration.
    const lastBlocked = [...(newState.history ?? [])]
      .reverse()
      .find((e) => e.event === 'node-blocked' && e.node_id === cursor.id);
    let unavailableAgents = [];
    if (lastBlocked?.payload?.escape_hatch === true) {
      const escapeVerdicts = (newState.history ?? []).filter((h) =>
        h.event === 'review-verdict'
        && h.node_id === cursor.id
        && h.payload?.escape_hatch === true
        && h.iteration === lastBlocked.iteration,
      );
      unavailableAgents = [...new Set(escapeVerdicts.map((h) => h.payload.agent))];
    }
    // Fallback: state.history may have been rotated such that the verdicts
    // (and possibly the node-blocked event itself) are no longer present in
    // the live state.history slice. The cursor.blocker_reason persists in
    // the tree (not subject to rotation) and carries the agent names in a
    // stable format `unavailable in this environment: <agent1>, <agent2>.`
    // produced by apply-mutations. Extract from there as the rotation-proof
    // path.
    if (unavailableAgents.length === 0 && typeof cursor.blocker_reason === 'string') {
      const match = /unavailable in this environment:\s*([^.]+?)\s*(?:\.|$)/i.exec(cursor.blocker_reason);
      if (match) {
        unavailableAgents = match[1]
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0 && /^[\w-]+$/.test(s));
      }
    }
    if (unavailableAgents.length > 0) {
      ctx.unavailable_reviewers = unavailableAgents.map((a) => ({ agent: a }));
      ctx.unavailable_reviewers_csv = unavailableAgents.join(', ');
    }
  }
  return ctx;
}
