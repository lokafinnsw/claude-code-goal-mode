/**
 * Stale-review-pending detector.
 *
 * v3.0.1 hardening for legacy v2 driver mode (`stopHookDriver: true`).
 * When a cursor sits in `review-pending` for >STALE_THRESHOLD_MS wall-clock
 * with no `review-verdict` history events appended, the engine auto-
 * transitions to lifecycle=`awaiting-manual-approval` so Stop-hook stops
 * re-rendering the (expensive) review continuation prompt.
 *
 * Distinguishes "controller is lazy" (no engagement at all) from
 * "controller is mid-flight waiting on Agent() result" by anchoring on
 * the review-requested event's timestamp + a verdict-absent check, not
 * on a silent-turn counter. So a heavy 5-min Agent() dispatch does NOT
 * trigger false-positive auto-pause.
 *
 * Recovery: /goal-mode:goal-approve <task-id> (manualApprove auto-handles
 * awaiting-manual-approval lifecycle from v2.0.4).
 */
export const STALE_REVIEW_THRESHOLD_MS = 15 * 60 * 1000; // 15 minutes

/**
 * Returns the most-recent `review-requested` event for the given node_id,
 * or null if none found.
 */
function findLastReviewRequested(history, nodeId) {
  for (let i = history.length - 1; i >= 0; i--) {
    const h = history[i];
    if (h.event === 'review-requested' && h.node_id === nodeId) return h;
  }
  return null;
}

/**
 * Returns true if any `review-verdict` event for the node was appended
 * after the given timestamp.
 */
function hasVerdictAfter(history, nodeId, sinceTs) {
  const sinceMs = new Date(sinceTs).getTime();
  for (const h of history) {
    if (h.event !== 'review-verdict') continue;
    if (h.node_id !== nodeId) continue;
    if (new Date(h.ts).getTime() > sinceMs) return true;
  }
  return false;
}

/**
 * Mutates state in place when stale-review condition is detected.
 * Returns { staled: bool, ageMs?: number, reason?: string }.
 *
 * Inputs:
 *   - state: GoalState (history will be appended; lifecycle may transition)
 *   - cursor: tree node currently pointed at by state.cursor (must be
 *             status === 'review-pending' for the check to run)
 *   - now: ms since epoch (Date.now() in production; injectable for tests)
 *   - thresholdMs: optional override (default STALE_REVIEW_THRESHOLD_MS)
 *
 * Side effects on stale:
 *   - cursor.status = 'blocked'
 *   - cursor.blocker_reason = informative message
 *   - state.lifecycle = 'awaiting-manual-approval'
 *   - history.push({event: 'review-pending-stale', node_id, payload: {age_ms, threshold_ms}})
 *   - history.push({event: 'lifecycle-changed', node_id, payload: {from, to, reason}})
 *
 * Safe to call from Stop-hook even when cursor isn't in review-pending —
 * no-ops in that case.
 */
export function checkStaleReviewPending(state, cursor, now, thresholdMs = STALE_REVIEW_THRESHOLD_MS) {
  if (!cursor || cursor.status !== 'review-pending') return { staled: false };
  if (state.lifecycle !== 'pursuing') return { staled: false };

  const reviewRequested = findLastReviewRequested(state.history, cursor.id);
  if (!reviewRequested) return { staled: false };

  if (hasVerdictAfter(state.history, cursor.id, reviewRequested.ts)) {
    return { staled: false };
  }

  const reqMs = new Date(reviewRequested.ts).getTime();
  const ageMs = now - reqMs;
  if (ageMs < thresholdMs) return { staled: false };

  const ts = new Date(now).toISOString();
  const ageMin = Math.round(ageMs / 60000);
  const reason =
    `review-pending stale: ${ageMin}m without verdict tags. ` +
    `Run /goal-mode:goal-approve ${cursor.id} to manually approve, ` +
    `or /goal-mode:goal-resume after fixing the underlying issue ` +
    `(e.g. controller stuck after heavy Agent() dispatch).`;

  cursor.status = 'blocked';
  cursor.blocker_reason = reason;
  state.lifecycle = 'awaiting-manual-approval';
  state.history.push({
    ts,
    iteration: state.budget.iterations.used,
    event: 'review-pending-stale',
    node_id: cursor.id,
    payload: { age_ms: ageMs, threshold_ms: thresholdMs },
  });
  state.history.push({
    ts,
    iteration: state.budget.iterations.used,
    event: 'lifecycle-changed',
    node_id: cursor.id,
    payload: {
      from: 'pursuing',
      to: 'awaiting-manual-approval',
      reason: 'review-pending-stale',
    },
  });

  return { staled: true, ageMs, reason };
}
