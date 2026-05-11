/**
 * Pure-function core of /goal:approve manual review override.
 *
 * Function: manualApprove(projectRoot, opts) → { ok, cursor?, error? }
 *
 * Use case: when a task is in review-pending and either the required
 * reviewers are not installed in the current environment OR the user
 * trusts their own judgment for this specific node, /goal:approve
 * bypasses the actual Agent() review by writing a synthetic
 * `agent: 'manual'`, `status: 'GO'` audit. The task is marked achieved
 * and cursor advances exactly as it would after a real all-GO verdict
 * batch.
 *
 * Inputs:
 *   - projectRoot: cwd of the user's Claude Code session.
 *   - opts.reason: optional string explaining the manual approval (will
 *     appear in the audit file's `text` field). Default: 'manual approve'.
 *
 * Returns:
 *   - { ok: true, cursor: <next-task-id-or-current-if-last> } on success.
 *   - { ok: false, error: <reason> } on any precondition failure:
 *       no state, no tree, cursor missing in tree, cursor not in
 *       review-pending status, lifecycle not pursuing.
 *
 * Pre-conditions:
 *   1. state.json exists (active goal).
 *   2. tree.json exists.
 *   3. state.cursor matches a node in tree.
 *   4. cursor.status === 'review-pending'.
 *   5. state.lifecycle === 'pursuing'.
 *
 * Side effects on success:
 *   - Mark cursor.status = 'achieved'.
 *   - Advance state.cursor to next pending task (via nextPendingTaskAfter)
 *     OR keep current cursor if no next pending (last task → goal achieved).
 *   - If last task, transition state.lifecycle to 'achieved'; set ended_at,
 *     ended_reason.
 *   - Append review-verdict + cursor-advanced history events.
 *   - Write audit JSON to .claude/goals/active/audits/<node>-<ts>-manual.json.
 *   - saveTree + saveState (atomic).
 *
 * Composition: loadTree, loadState, saveTree, saveState (Phase 1);
 * findNodeById, nextPendingTaskAfter (Phase 1); auditsDir (Phase 1 paths).
 */

import fs from 'node:fs';
import path from 'node:path';
import { loadTree, loadState, saveTree, saveState } from './state.mjs';
import { findNodeById, nextPendingTaskAfter } from './traversal.mjs';
import { auditsDir, activeDir } from './paths.mjs';
import { withLockSync } from './lock.mjs';

// Defensive filename sanitization (mirrors apply-mutations.mjs): node.id
// comes from user-edited tree.json. If it contains '/' or other path-illegal
// chars, fs.writeFileSync would fail or write to an unintended subdirectory.
// Sanitization is filename-only — the JSON body keeps the original value.
function safeFilenamePart(s) {
  // Allow [a-zA-Z0-9._-]; collapse runs of 2+ dots to '_' to prevent '..'
  // surviving sanitization (defense-in-depth — see twin in apply-mutations.mjs).
  return String(s).replace(/[^a-zA-Z0-9._-]/g, '_').replace(/\.{2,}/g, '_');
}

export function manualApprove(projectRoot, { reason = 'manual approve' } = {}) {
  return withLockSync(activeDir(projectRoot), 'manual-approve', {}, () => {
  const state = loadState(projectRoot);
  if (!state) return { ok: false, error: 'No active goal.' };
  if (state.lifecycle !== 'pursuing') {
    return { ok: false, error: `cannot manually approve from lifecycle=${state.lifecycle}` };
  }
  const tree = loadTree(projectRoot);
  if (!tree) return { ok: false, error: 'no tree.json found' };

  const node = findNodeById(tree, state.cursor);
  if (!node) {
    return { ok: false, error: `cursor ${state.cursor} not found in tree` };
  }
  if (node.status !== 'review-pending') {
    return { ok: false, error: `cursor not review-pending (is ${node.status})` };
  }

  const ts = new Date().toISOString();
  const auditDir = auditsDir(projectRoot);
  fs.mkdirSync(auditDir, { recursive: true });
  const fname = `${safeFilenamePart(node.id)}-${ts.replace(/[:.]/g, '-')}-manual.json`;
  fs.writeFileSync(
    path.join(auditDir, fname),
    JSON.stringify(
      {
        ts,
        node_id: node.id,
        kind: 'audit-verdict',
        agent: 'manual',
        status: 'GO',
        text: reason,
        manual: true,
      },
      null,
      2
    )
  );

  node.status = 'achieved';
  const next = nextPendingTaskAfter(tree, node.id);
  state.cursor = next ? next.id : node.id;

  // NOTE: manualApprove does NOT increment state.budget.iterations.used.
  // A manual review is a user action between iterations, not an iteration
  // of the agent's own work. The recorded `iteration` field tracks the
  // counter as-of the user's invocation. Compare to applyMutations, which
  // also doesn't increment (the Stop hook bumps the counter once per turn
  // before calling applyMutations).
  state.history.push({
    ts,
    iteration: state.budget.iterations.used,
    event: 'review-verdict',
    node_id: node.id,
    payload: { agent: 'manual', status: 'GO', text: reason },
  });
  state.history.push({
    ts,
    iteration: state.budget.iterations.used,
    event: 'cursor-advanced',
    node_id: node.id,
    payload: { from: 'manual-approve' },
  });

  if (!next) {
    state.lifecycle = 'achieved';
    state.ended_at = ts;
    state.ended_reason = 'all tasks achieved (last via manual approve)';
    state.history.push({
      ts,
      iteration: state.budget.iterations.used,
      event: 'achieved',
      node_id: null,
      payload: {},
    });
  }

  saveTree(projectRoot, tree);
  saveState(projectRoot, state);

  return { ok: true, cursor: state.cursor };
  });
}
