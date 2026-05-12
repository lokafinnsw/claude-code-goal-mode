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
 *   2. lifecycle in {'pursuing', 'budget-limited'}. Anything else rejects
 *      (paused/achieved/unmet/draft/approved/awaiting-manual-approval all
 *      have different recovery paths; bumping budget on them would either
 *      be a no-op or hide a real problem).
 *   3. At least one of {tokens, iter, time} provided.
 *   4. The resulting new max for each dimension is >= already-consumed
 *      `used` count. Lifting the ceiling below already-spent budget would
 *      put the state in an instantly-budget-limited shape; reject early
 *      with a clear error instead.
 *
 * Returns:
 *   - { ok: true, old, new, lifecycle_transition? } on success.
 *       old/new = { iter, tokens, time_seconds }.
 *       lifecycle_transition = { from, to } when budget-limited → pursuing.
 *   - { ok: false, error } on any precondition failure.
 *
 * Side effects on success:
 *   - Updates state.budget.{iterations.max, tokens.max, wallclock.max_seconds}.
 *     Dimensions NOT in opts are left untouched.
 *   - If lifecycle was 'budget-limited': transition to 'pursuing',
 *     clear ended_at and ended_reason. (Stop hook gate then re-fires.)
 *   - Append a 'budget-extended' history event with payload
 *     { old, new, transition }.
 *   - saveState (atomic).
 *
 * Error messages match the engine/manual-approve.mjs convention
 * (`cannot X from lifecycle=Y` form) so existing CLI scripts and grep
 * patterns generalize.
 *
 * Composition: loadState, saveState (state.mjs); activeDir (paths.mjs);
 * withLockSync (lock.mjs).
 */

import { loadState, saveState } from './state.mjs';
import { activeDir } from './paths.mjs';
import { withLockSync } from './lock.mjs';

export function extendBudget(projectRoot, opts = {}) {
  if (!opts.tokens && !opts.iter && !opts.time) {
    return { ok: false, error: 'at least one of --tokens, --iter, --time required' };
  }
  return withLockSync(activeDir(projectRoot), 'goal-extend', {}, () => {
    const state = loadState(projectRoot);
    if (!state) return { ok: false, error: 'No active goal.' };
    if (state.lifecycle !== 'pursuing' && state.lifecycle !== 'budget-limited') {
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

    let transition = null;
    if (state.lifecycle === 'budget-limited') {
      state.lifecycle = 'pursuing';
      state.ended_at = null;
      state.ended_reason = null;
      transition = { from: 'budget-limited', to: 'pursuing' };
    }

    const ts = new Date().toISOString();
    state.history.push({
      ts,
      iteration: state.budget.iterations.used,
      event: 'budget-extended',
      node_id: state.cursor,
      payload: { old, new: newMax, transition },
    });

    saveState(projectRoot, state);
    return { ok: true, old, new: newMax, lifecycle_transition: transition };
  });
}
