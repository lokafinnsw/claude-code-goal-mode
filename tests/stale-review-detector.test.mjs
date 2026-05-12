import { describe, it, expect } from 'vitest';
import { checkStaleReviewPending, STALE_REVIEW_THRESHOLD_MS } from '../engine/stale-review-detector.mjs';

function mkState({ lifecycle = 'pursuing', cursor = 't', history = [] } = {}) {
  return {
    schema_version: 2, goal_id: 'g', lifecycle, cursor,
    budget: { iterations: { used: 1, max: 100 }, tokens: { used: 0, max: 0 },
      wallclock: { started_at: '2026-05-12T00:00:00.000Z', max_seconds: 86400 } },
    session_id: 's', started_at: '2026-05-12T00:00:00.000Z',
    paused_at: null, ended_at: null, ended_reason: null,
    history,
    consecutive_silent_turns: 0,
  };
}

function mkCursor({ id = 't', status = 'review-pending' } = {}) {
  return {
    id, type: 'task', title: 't', goal: 'g',
    acceptance_criteria: ['c0'], review: ['aaa-art-director'],
    validate: null, work_front: null, status,
    evidence: [], blocker_reason: null, review_attempts: 0,
    notes: [], children: [],
  };
}

const NOW = new Date('2026-05-12T01:00:00.000Z').getTime();

describe('checkStaleReviewPending', () => {
  it('returns staled=false when cursor not review-pending', () => {
    const state = mkState();
    const cursor = mkCursor({ status: 'pursuing' });
    const r = checkStaleReviewPending(state, cursor, NOW);
    expect(r.staled).toBe(false);
    expect(cursor.status).toBe('pursuing');  // unchanged
    expect(state.lifecycle).toBe('pursuing');  // unchanged
  });

  it('returns staled=false when no review-requested event found', () => {
    const state = mkState();
    const cursor = mkCursor();
    const r = checkStaleReviewPending(state, cursor, NOW);
    expect(r.staled).toBe(false);
  });

  it('returns staled=false when review-requested is recent (<threshold)', () => {
    // request 5min ago, threshold 15min
    const reqTs = new Date(NOW - 5 * 60 * 1000).toISOString();
    const state = mkState({
      history: [{ ts: reqTs, iteration: 1, event: 'review-requested', node_id: 't', payload: { agents: ['x'] } }],
    });
    const cursor = mkCursor();
    const r = checkStaleReviewPending(state, cursor, NOW);
    expect(r.staled).toBe(false);
  });

  it('returns staled=false when a verdict exists after review-requested', () => {
    // request 20min ago, verdict 10min ago — not stale
    const reqTs = new Date(NOW - 20 * 60 * 1000).toISOString();
    const vTs = new Date(NOW - 10 * 60 * 1000).toISOString();
    const state = mkState({
      history: [
        { ts: reqTs, iteration: 1, event: 'review-requested', node_id: 't', payload: { agents: ['x'] } },
        { ts: vTs, iteration: 2, event: 'review-verdict', node_id: 't', payload: { agent: 'x', status: 'NOGO' } },
      ],
    });
    const cursor = mkCursor();
    const r = checkStaleReviewPending(state, cursor, NOW);
    expect(r.staled).toBe(false);
  });

  it('mutates to awaiting-manual-approval when stale + no verdict', () => {
    // request 20min ago, no verdicts → stale
    const reqTs = new Date(NOW - 20 * 60 * 1000).toISOString();
    const state = mkState({
      history: [{ ts: reqTs, iteration: 1, event: 'review-requested', node_id: 't', payload: { agents: ['x'] } }],
    });
    const cursor = mkCursor();
    const r = checkStaleReviewPending(state, cursor, NOW);
    expect(r.staled).toBe(true);
    expect(r.ageMs).toBeGreaterThan(STALE_REVIEW_THRESHOLD_MS);
    expect(cursor.status).toBe('blocked');
    expect(cursor.blocker_reason).toMatch(/stale.*verdict/i);
    expect(cursor.blocker_reason).toMatch(/goal-approve/);
    expect(state.lifecycle).toBe('awaiting-manual-approval');
    const staleEvent = state.history.find(h => h.event === 'review-pending-stale');
    expect(staleEvent).toBeDefined();
    expect(staleEvent.payload.age_ms).toBeGreaterThan(STALE_REVIEW_THRESHOLD_MS);
    const lcEvent = state.history.find(h => h.event === 'lifecycle-changed');
    expect(lcEvent).toBeDefined();
    expect(lcEvent.payload.to).toBe('awaiting-manual-approval');
  });

  it('respects custom threshold for tests', () => {
    const reqTs = new Date(NOW - 60 * 1000).toISOString();  // 1 min ago
    const state = mkState({
      history: [{ ts: reqTs, iteration: 1, event: 'review-requested', node_id: 't', payload: {} }],
    });
    const cursor = mkCursor();
    // With 30s threshold, 1min ago is stale
    const r = checkStaleReviewPending(state, cursor, NOW, 30 * 1000);
    expect(r.staled).toBe(true);
  });

  it('skips check when lifecycle is not pursuing', () => {
    const reqTs = new Date(NOW - 20 * 60 * 1000).toISOString();
    const state = mkState({
      lifecycle: 'paused',
      history: [{ ts: reqTs, iteration: 1, event: 'review-requested', node_id: 't', payload: {} }],
    });
    const cursor = mkCursor();
    const r = checkStaleReviewPending(state, cursor, NOW);
    expect(r.staled).toBe(false);
  });

  it('null cursor does not throw', () => {
    const state = mkState();
    const r = checkStaleReviewPending(state, null, NOW);
    expect(r.staled).toBe(false);
  });
});
