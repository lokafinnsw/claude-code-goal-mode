/**
 * Pure-function core of /goal-mode:achieve.
 *
 * Validates all ACs covered, then synthesizes a <task-status>achieved</>
 * tag and dispatches to applyMutations. Mirrors the legacy tag-emission
 * path while removing the requirement to emit XML in the assistant reply.
 *
 * Preconditions:
 *   1. state.json exists.
 *   2. state.lifecycle === 'pursuing'.
 *   3. tree.json exists.
 *   4. state.cursor matches a node in tree.
 *
 * Returns:
 *   { ok: true, status: 'achieved'|'review-pending',
 *     next_cursor?, required_reviewers? }
 *   { ok: false, missing_criteria: [int...] }   when ACs not fully covered
 *   { ok: false, error }                        on any other failure
 *
 * Error messages match engine/manual-approve.mjs convention.
 */
import { loadTree, loadState, saveTree, saveState } from './state.mjs';
import { findNodeById } from './traversal.mjs';
import { applyMutations } from './apply-mutations.mjs';
import { activeDir } from './paths.mjs';
import { withLockSync } from './lock.mjs';

export function achieveCursor(projectRoot) {
  return withLockSync(activeDir(projectRoot), 'achieve', {}, () => {
    const state = loadState(projectRoot);
    if (!state) return { ok: false, error: 'No active goal.' };
    if (state.lifecycle !== 'pursuing') {
      return { ok: false, error: `cannot achieve from lifecycle=${state.lifecycle}` };
    }
    const tree = loadTree(projectRoot);
    if (!tree) return { ok: false, error: 'no tree.json found' };
    const cursor = findNodeById(tree, state.cursor);
    if (!cursor) return { ok: false, error: `cursor ${state.cursor} not found in tree` };
    if (cursor.type !== 'task') {
      return { ok: false, error: `cannot achieve non-task node (cursor=${cursor.id}, type=${cursor.type})` };
    }
    // v3.0.3: auto-promote pending → pursuing on first engagement.
    // Symmetric with evidence-add. Closes deadlock when caller jumps
    // straight to achieve (e.g. tests with pre-seeded evidence on a
    // pending-status cursor).
    if (cursor.status === 'pending' && cursor.type === 'task') {
      cursor.status = 'pursuing';
      const tsEngaged = new Date().toISOString();
      state.history.push({
        ts: tsEngaged,
        iteration: state.budget.iterations.used,
        event: 'cursor-engaged',
        node_id: cursor.id,
        payload: { from: 'pending', to: 'pursuing', reason: 'v3-cli-achieve' },
      });
    }

    // Compute missing criteria BEFORE invoking applyMutations so the caller
    // gets a clear error rather than a silent no-op (applyMutations's
    // allCriteriaCovered check returns false and the status tag falls through
    // to a `cursor.status='pursuing'` no-op, which is correct semantics but
    // unhelpful UX for an explicit CLI invocation).
    const covered = new Set();
    for (const ev of cursor.evidence) {
      if (ev.criterion_index !== null && ev.criterion_index >= 0 &&
          ev.criterion_index < cursor.acceptance_criteria.length) {
        covered.add(ev.criterion_index);
      }
    }
    const missing = [];
    for (let i = 0; i < cursor.acceptance_criteria.length; i++) {
      if (!covered.has(i)) missing.push(i);
    }
    if (missing.length > 0) {
      return { ok: false, missing_criteria: missing };
    }

    const ts = new Date().toISOString();
    const tag = { kind: 'task-status', value: 'achieved' };
    const { tree: tree2, state: state2 } = applyMutations(tree, state, [tag], ts);
    saveTree(projectRoot, tree2);
    saveState(projectRoot, state2);

    const newCursorNode = findNodeById(tree2, cursor.id);
    if (newCursorNode.status === 'achieved') {
      return { ok: true, status: 'achieved', next_cursor: state2.cursor };
    }
    if (newCursorNode.status === 'review-pending') {
      return {
        ok: true, status: 'review-pending',
        required_reviewers: [...cursor.review],
      };
    }
    return { ok: false, error: `unexpected post-achieve status: ${newCursorNode.status}` };
  });
}
