/**
 * Compute elapsed wallclock minutes from state.budget.wallclock.started_at.
 *
 * Returns the number of whole minutes between `started_at` and `now`, clamped
 * to a minimum of 0 (handles clock-skew where started_at is in the future)
 * and to a minimum of 0 when `started_at` is an invalid date string (corrupt
 * or hand-edited state).
 *
 * Used by:
 *   - continuation.mjs::buildContext (continuation prompts).
 *   - render-status.mjs::renderStatus (/goal:status report).
 *   - stop-hook.mjs::buildSummaryContext (final-summary template ctx).
 *   - stop-hook.mjs::buildUnmetContext (unmet-summary template ctx).
 *
 * Pure given fixed `now`. No I/O.
 */
export function wallclockMinutes(state, now = Date.now()) {
  const wallStart = new Date(state.budget.wallclock.started_at).getTime();
  if (Number.isNaN(wallStart)) return 0;
  return Math.max(0, Math.floor((now - wallStart) / 60000));
}
