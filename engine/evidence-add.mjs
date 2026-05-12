/**
 * Pure-function core of /goal-mode:evidence-add.
 *
 * Synthesizes a single `evidence` tag and dispatches to applyMutations.
 * The agent uses this to write evidence to the cursor node WITHOUT
 * emitting <evidence/> tags in the assistant reply — the v3.0 explicit
 * CLI path bypasses the parse-tags layer entirely.
 *
 * Preconditions:
 *   1. state.json exists.
 *   2. tree.json exists.
 *   3. state.cursor matches a node in tree.
 *   4. state.lifecycle === 'pursuing'.
 *   5. cursor.status in {'pursuing', 'review-pending'}.
 *
 * Inputs: { criterion?: int, file?: string, line?: int, command?: string,
 *           exit_code?: int, note?: string }
 *
 * Returns: { ok, evidence_count?, error? }
 */
import { loadTree, loadState, saveTree, saveState } from './state.mjs';
import { findNodeById } from './traversal.mjs';
import { applyMutations } from './apply-mutations.mjs';
import { activeDir } from './paths.mjs';
import { withLockSync } from './lock.mjs';

export function evidenceAdd(
  projectRoot,
  {
    criterion = null,
    file = null,
    line = null,
    command = null,
    exit_code = null,
    note = '',
  } = {}
) {
  return withLockSync(activeDir(projectRoot), 'evidence-add', {}, () => {
    const state = loadState(projectRoot);
    if (!state) return { ok: false, error: 'No active goal.' };
    if (state.lifecycle !== 'pursuing') {
      return { ok: false, error: `cannot add evidence from lifecycle=${state.lifecycle}` };
    }
    const tree = loadTree(projectRoot);
    if (!tree) return { ok: false, error: 'no tree.json found' };
    const cursor = findNodeById(tree, state.cursor);
    if (!cursor) {
      return { ok: false, error: `cursor ${state.cursor} not found in tree` };
    }
    // v3.0.3: auto-promote pending → pursuing on first engagement.
    // Closes a deadlock where cursor was left in 'pending' status after
    // goal-resume (or by historical v2 advance paths that didn't emit
    // <task-status>pursuing</>), making v3 CLI verbs un-callable.
    // Mutation is recorded as a 'cursor-engaged' history event.
    if (cursor.status === 'pending' && cursor.type === 'task') {
      cursor.status = 'pursuing';
      const tsEngaged = new Date().toISOString();
      state.history.push({
        ts: tsEngaged,
        iteration: state.budget.iterations.used,
        event: 'cursor-engaged',
        node_id: cursor.id,
        payload: { from: 'pending', to: 'pursuing', reason: 'v3-cli-evidence-add' },
      });
    }
    if (cursor.status !== 'pursuing' && cursor.status !== 'review-pending') {
      return {
        ok: false,
        error: `cursor not pursuing or review-pending (is ${cursor.status}, lifecycle=${state.lifecycle})`,
      };
    }

    const ts = new Date().toISOString();
    const tag = {
      kind: 'evidence',
      criterion,
      file,
      line,
      command,
      exit_code,
      note,
    };
    const { tree: tree2, state: state2 } = applyMutations(tree, state, [tag], ts);
    saveTree(projectRoot, tree2);
    saveState(projectRoot, state2);
    const updated = findNodeById(tree2, state.cursor);
    return { ok: true, evidence_count: updated.evidence.length };
  });
}
