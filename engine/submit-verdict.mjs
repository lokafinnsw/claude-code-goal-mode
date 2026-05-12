/**
 * Pure-function core of /goal-mode:submit-verdict.
 *
 * Used after the agent dispatches a reviewer subagent via Agent() and
 * collects its verdict (GO/NOGO/REVISE). Routes through applyMutations
 * with opts.scannedAgents so reviewer-independence enforcement (and the
 * escape-hatch detector) still fires.
 *
 * Preconditions:
 *   1. state.json exists.
 *   2. state.lifecycle === 'pursuing'.
 *   3. tree.json exists.
 *   4. state.cursor matches a node in tree.
 *   5. cursor.status === 'review-pending'.
 *   6. opts.agent (non-empty string).
 *   7. opts.status in {GO, NOGO, REVISE}.
 *   8. opts.scannedAgents is a Set instance (used by independence guard).
 *
 * Inputs: { agent, status, text?, scannedAgents }
 *
 * Returns:
 *   - { ok: true, status, next_cursor? }   when accepted
 *       - status: cursor.status after mutation
 *           ('achieved' if last reviewer + all GO,
 *            'review-pending' otherwise,
 *            'blocked' on escape-hatch path)
 *       - next_cursor: only present when cursor advanced
 *   - { ok: false, error }                 when rejected (independence
 *                                          violation, no dispatch detected,
 *                                          and not an escape-hatch)
 *
 * SECURITY BOUNDARY: this core trusts opts.scannedAgents verbatim. The CLI
 * layer (engine/submit-verdict-cli.mjs, Sprint 1.6) is responsible for
 * populating it from a REAL transcript scan of Agent() dispatches in the
 * current turn. A caller passing a forged Set bypasses reviewer-independence
 * enforcement — that is by design; verification belongs at the trust
 * boundary, not duplicated here. Direct programmatic callers (tests) must
 * supply the Set explicitly with full knowledge of this contract.
 *
 * Error messages match engine/manual-approve.mjs convention.
 */
import { loadTree, loadState, saveTree, saveState } from './state.mjs';
import { findNodeById } from './traversal.mjs';
import { applyMutations } from './apply-mutations.mjs';
import { activeDir, auditsDir } from './paths.mjs';
import { withLockSync } from './lock.mjs';

const VALID_STATUSES = Object.freeze(new Set(['GO', 'NOGO', 'REVISE']));

export function submitVerdict(projectRoot, opts = {}) {
  if (!opts.agent || typeof opts.agent !== 'string') {
    return { ok: false, error: 'agent (non-empty string) required' };
  }
  if (!VALID_STATUSES.has(opts.status)) {
    return { ok: false, error: `invalid status ${opts.status}; expected one of GO, NOGO, REVISE` };
  }
  if (!(opts.scannedAgents instanceof Set)) {
    return { ok: false, error: 'scannedAgents (Set) required for reviewer-independence enforcement' };
  }
  return withLockSync(activeDir(projectRoot), 'submit-verdict', {}, () => {
    const state = loadState(projectRoot);
    if (!state) return { ok: false, error: 'No active goal.' };
    if (state.lifecycle !== 'pursuing') {
      return { ok: false, error: `cannot submit verdict from lifecycle=${state.lifecycle}` };
    }
    const tree = loadTree(projectRoot);
    if (!tree) return { ok: false, error: 'no tree.json found' };
    const cursor = findNodeById(tree, state.cursor);
    if (!cursor) return { ok: false, error: `cursor ${state.cursor} not found in tree` };
    if (cursor.status !== 'review-pending') {
      return { ok: false, error: `cursor not review-pending (is ${cursor.status})` };
    }

    const tag = {
      kind: 'audit-verdict',
      agent: opts.agent,
      status: opts.status,
      text: opts.text ?? '',
    };
    const ts = new Date().toISOString();
    const { tree: tree2, state: state2 } = applyMutations(
      tree, state, [tag], ts,
      { scannedAgents: opts.scannedAgents, auditsDir: auditsDir(projectRoot) },
    );

    // Detect rejection: applyMutations adds a history entry with
    // rejected=true when scannedAgents doesn't include the agent AND
    // the verdict isn't an escape-hatch. Persist the rejection (audit
    // trail) but signal to the caller via ok:false.
    const newEvents = state2.history.slice(state.history.length);
    const rejected = newEvents.find(
      h => h.event === 'review-verdict' && h.payload?.rejected,
    );
    if (rejected) {
      saveTree(projectRoot, tree2);
      saveState(projectRoot, state2);
      return {
        ok: false,
        error: `reviewer-independence violation: ${rejected.payload.reason}`,
      };
    }

    saveTree(projectRoot, tree2);
    saveState(projectRoot, state2);

    const c = findNodeById(tree2, cursor.id);
    return {
      ok: true,
      status: c.status,
      next_cursor: c.status === 'achieved' ? state2.cursor : undefined,
    };
  });
}
