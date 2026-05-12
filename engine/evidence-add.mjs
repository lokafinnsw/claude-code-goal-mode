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

export function evidenceAdd(projectRoot, opts) {
  return withLockSync(activeDir(projectRoot), 'evidence-add', {}, () => {
    const state = loadState(projectRoot);
    if (!state) return { ok: false, error: 'no active goal' };
    if (state.lifecycle !== 'pursuing') {
      return { ok: false, error: `cannot add evidence from lifecycle=${state.lifecycle}` };
    }
    const tree = loadTree(projectRoot);
    if (!tree) return { ok: false, error: 'no tree.json' };
    const cursor = findNodeById(tree, state.cursor);
    if (!cursor) return { ok: false, error: `cursor ${state.cursor} not in tree` };
    if (cursor.status !== 'pursuing' && cursor.status !== 'review-pending') {
      return { ok: false, error: `cursor.status=${cursor.status}; expected pursuing or review-pending` };
    }

    const ts = new Date().toISOString();
    const tag = {
      kind: 'evidence',
      criterion: opts.criterion ?? null,
      file: opts.file ?? null,
      line: opts.line ?? null,
      command: opts.command ?? null,
      exit_code: opts.exit_code ?? null,
      note: opts.note ?? '',
    };
    const { tree: tree2, state: state2 } = applyMutations(tree, state, [tag], ts);
    saveTree(projectRoot, tree2);
    saveState(projectRoot, state2);
    const updated = findNodeById(tree2, state.cursor);
    return { ok: true, evidence_count: updated.evidence.length };
  });
}
