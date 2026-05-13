/**
 * Pure-function core of /goal-mode:goal-extend.
 *
 * Bumps budget limits on an active or budget-limited goal without
 * clearing and re-planning. Supports delta (+N) and absolute (N) modes
 * per dimension (tokens / iterations / wall-clock seconds).
 *
 * v3.0.8 motivation: when a long autonomous run hits the triple-budget
 * ceiling (e.g. 91/158 tasks done at 60M tokens), the only recovery
 * pre-v3.0.8 was `/goal-clear --archive` + re-plan from scratch. That
 * loses cursor + history + evidence + audits + tree shape. goal-extend
 * lifts the ceiling explicitly when the user wants more headroom and
 * transitions `budget-limited → pursuing` so the Stop hook resumes
 * firing continuation prompts on the existing plan.
 *
 * Inputs: { tokens?, iter?, time? } — each value is
 *   { mode: 'delta' | 'absolute', value: number }.
 *   - tokens, iter: integer count.
 *   - time: integer seconds.
 *
 * Preconditions:
 *   1. state.json exists.
 *   2. lifecycle in {'pursuing', 'budget-limited', 'unmet'}. Anything else
 *      rejects (paused/achieved/draft/approved/awaiting-manual-approval all
 *      have different recovery paths; bumping budget on them would either
 *      be a no-op or hide a real problem).
 *   3. At least one of {tokens, iter, time} provided.
 *   4. The resulting new max for each dimension is >= already-consumed
 *      `used` count. Lifting the ceiling below already-spent budget would
 *      put the state in an instantly-budget-limited shape; reject early
 *      with a clear error instead.
 *
 * Returns:
 *   - { ok: true, old, new, lifecycle_transition?, cursor_reset? } on success.
 *       old/new = { iter, tokens, time_seconds }.
 *       lifecycle_transition = { from, to } when budget-limited|unmet → pursuing.
 *       cursor_reset = { node_id, from_status, from_review_attempts,
 *         from_blocker_reason } when reopening from unmet with cursor in
 *         3-NOGO-blocked shape (status=blocked AND review_attempts>=3).
 *   - { ok: false, error } on any precondition failure.
 *
 * Side effects on success:
 *   - Updates state.budget.{iterations.max, tokens.max, wallclock.max_seconds}.
 *     Dimensions NOT in opts are left untouched.
 *   - If lifecycle was 'budget-limited' OR 'unmet': transition to 'pursuing',
 *     clear ended_at and ended_reason. (Stop hook gate then re-fires.)
 *   - v3.0.9: when reopening from 'unmet' AND the cursor is in 3-NOGO
 *     escalation state (status=blocked AND review_attempts>=3), also reset
 *     cursor.status='pursuing', cursor.review_attempts=0,
 *     cursor.blocker_reason=null so work can resume past the escalation.
 *     The 3-strike-NOGO canon in apply-mutations.mjs still applies on the
 *     next review cycle.
 *   - Append a 'budget-extended' history event with payload
 *     { old, new, transition, cursor_reset }.
 *   - saveState + saveTree (atomic).
 *
 * Error messages match the engine/manual-approve.mjs convention
 * (`cannot X from lifecycle=Y` form) so existing CLI scripts and grep
 * patterns generalize.
 *
 * Composition: loadState, saveState (state.mjs); activeDir (paths.mjs);
 * withLockSync (lock.mjs).
 */

import { loadState, saveState, loadTree, saveTree } from './state.mjs';
import { activeDir } from './paths.mjs';
import { withLockSync } from './lock.mjs';
import { findNodeById } from './traversal.mjs';

// v3.0.9: lifecycles from which `/goal-extend` can recover. `unmet` joins
// `budget-limited` because both are auto-escalation end states that the
// user often wants to reopen in-place rather than via /goal-clear + replan.
const REOPENABLE_LIFECYCLES = new Set(['pursuing', 'budget-limited', 'unmet']);

export function extendBudget(projectRoot, opts = {}) {
  if (!opts.tokens && !opts.iter && !opts.time) {
    return { ok: false, error: 'at least one of --tokens, --iter, --time required' };
  }
  return withLockSync(activeDir(projectRoot), 'goal-extend', {}, () => {
    const state = loadState(projectRoot);
    if (!state) return { ok: false, error: 'No active goal.' };
    if (!REOPENABLE_LIFECYCLES.has(state.lifecycle)) {
      return { ok: false, error: `cannot extend budget from lifecycle=${state.lifecycle}` };
    }

    const old = {
      iter: state.budget.iterations.max,
      tokens: state.budget.tokens.max,
      time_seconds: state.budget.wallclock.max_seconds,
    };

    const apply = (current, spec) => {
      if (!spec) return current;
      if (spec.mode === 'delta') return current + spec.value;
      return spec.value;
    };

    const newMax = {
      iter: apply(old.iter, opts.iter),
      tokens: apply(old.tokens, opts.tokens),
      time_seconds: apply(old.time_seconds, opts.time),
    };

    // Validation: new max must be >= current used. Cannot bump DOWN
    // below already-consumed budget — that would put state into an
    // instantly-budget-limited shape on the next stop-hook tick.
    if (newMax.iter < state.budget.iterations.used) {
      return {
        ok: false,
        error: `iter max (${newMax.iter}) < used (${state.budget.iterations.used})`,
      };
    }
    if (newMax.tokens < state.budget.tokens.used) {
      return {
        ok: false,
        error: `tokens max (${newMax.tokens}) < used (${state.budget.tokens.used})`,
      };
    }
    // Note: wallclock has no `used` counter (it's computed from
    // started_at + now), so we don't bound-check time_seconds here.

    state.budget.iterations.max = newMax.iter;
    state.budget.tokens.max = newMax.tokens;
    state.budget.wallclock.max_seconds = newMax.time_seconds;

    // v3.0.9: when reopening from 'unmet', also reset the blocking cursor
    // so work can resume. 'unmet' typically results from 3-strike NOGO
    // escalation (engine canon in apply-mutations.mjs); without resetting
    // cursor.status and cursor.review_attempts, the controller would still
    // be locked out of /goal-review-request on the same node. We only
    // touch the cursor when it is unambiguously in the 3-NOGO shape
    // (status=blocked AND review_attempts>=3). Other blocked states
    // (e.g. escape-hatch unavailable-reviewer) are intentionally left
    // alone — they have different recovery paths.
    let cursorReset = null;
    if (state.lifecycle === 'unmet') {
      const tree = loadTree(projectRoot);
      if (tree) {
        const cursorNode = findNodeById(tree, state.cursor);
        if (
          cursorNode &&
          cursorNode.status === 'blocked' &&
          cursorNode.review_attempts >= 3
        ) {
          cursorReset = {
            node_id: cursorNode.id,
            from_status: cursorNode.status,
            from_review_attempts: cursorNode.review_attempts,
            from_blocker_reason: cursorNode.blocker_reason,
          };
          cursorNode.status = 'pursuing';
          cursorNode.review_attempts = 0;
          cursorNode.blocker_reason = null;
          saveTree(projectRoot, tree);
        }
      }
    }

    let transition = null;
    if (state.lifecycle === 'budget-limited' || state.lifecycle === 'unmet') {
      const from = state.lifecycle;
      state.lifecycle = 'pursuing';
      state.ended_at = null;
      state.ended_reason = null;
      transition = { from, to: 'pursuing' };
    }

    const ts = new Date().toISOString();
    state.history.push({
      ts,
      iteration: state.budget.iterations.used,
      event: 'budget-extended',
      node_id: state.cursor,
      payload: { old, new: newMax, transition, cursor_reset: cursorReset },
    });

    saveState(projectRoot, state);
    return {
      ok: true,
      old,
      new: newMax,
      lifecycle_transition: transition,
      cursor_reset: cursorReset,
    };
  });
}
