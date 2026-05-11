/**
 * Regression test for the v2.0.0 escape-hatch / infinite-loop bug
 * (user-reported on 2026-05-11):
 *
 *   When a reviewer's subagent_type is unavailable in the environment,
 *   commands/goal-review.md and prompts/continuation-review.md instruct the
 *   assistant to emit:
 *
 *     <audit-verdict agent="X" status="REVISE">unavailable; user must run
 *       /goal-approve</audit-verdict>
 *
 *   without an Agent dispatch (the subagent CANNOT be dispatched — the type
 *   isn't registered). In v2.0.0 the new reviewer-independence detector
 *   rejected this verdict as "fabricated", which made the Stop-hook re-fire
 *   the same review-pending prompt forever — the assistant could neither
 *   dispatch (impossible) nor escape (rejected). The fix routes the escape-
 *   hatch pattern to the blocked lifecycle with a recovery-hint blocker
 *   reason on the first occurrence, so the user sees a clear next action
 *   (/goal-approve OR register the agent) without an N-cycle delay.
 */
import { describe, it, expect } from 'vitest';
import { applyMutations } from '../engine/apply-mutations.mjs';

const TS = '2026-05-11T12:00:00.000Z';

const mkTree = (status = 'review-pending', review = ['aaa-art-director']) => ({
  schema_version: 2,
  goal_id: 'g',
  mission: 'm',
  created_at: '2026-05-09T00:00:00.000Z',
  approved_at: null,
  root: {
    id: 't', type: 'task', title: 't', goal: 'g',
    acceptance_criteria: ['c0'],
    review,
    validate: null, work_front: null,
    status,
    evidence: [{ criterion_index: 0, file: 'a', note: 'n', iteration: 1 }],
    blocker_reason: null,
    review_attempts: 0, notes: [], children: [],
  },
});

const mkState = () => ({
  schema_version: 2,
  goal_id: 'g',
  lifecycle: 'pursuing',
  cursor: 't',
  budget: {
    iterations: { used: 5, max: 100 },
    tokens: { used: 0, max: 0 },
    wallclock: { started_at: '2026-05-09T00:00:00.000Z', max_seconds: 0 },
  },
  session_id: 's',
  started_at: '2026-05-09T00:00:00.000Z',
  paused_at: null, ended_at: null, ended_reason: null,
  history: [],
});

const escapeHatchVerdict = (text = 'unavailable; user must run /goal-approve') => ({
  kind: 'audit-verdict',
  agent: 'aaa-art-director',
  status: 'REVISE',
  text,
});

describe('escape-hatch: reviewer unavailable in environment', () => {
  it('marks cursor blocked immediately when escape-hatch verdict is emitted without Agent dispatch', () => {
    const tree = mkTree();
    const state = mkState();
    const { tree: t2, state: s2 } = applyMutations(
      tree, state, [escapeHatchVerdict()], TS,
      { scannedAgents: new Set() }, // no Agent dispatch this turn
    );
    expect(t2.root.status).toBe('blocked');
    expect(t2.root.blocker_reason).toMatch(/unavailable.*aaa-art-director/);
    expect(t2.root.blocker_reason).toMatch(/\/goal-mode:goal-approve t/);
    expect(t2.root.blocker_reason).toMatch(/~\/\.claude\/agents/);
    // review_attempts NOT incremented (this isn't a real review failure —
    // the reviewer can't be reached at all).
    expect(t2.root.review_attempts).toBe(0);
  });

  it('emits a node-blocked event with escape_hatch=true', () => {
    const tree = mkTree();
    const state = mkState();
    const { history } = applyMutations(
      tree, state, [escapeHatchVerdict()], TS,
      { scannedAgents: new Set() },
    );
    const blocked = history.find((h) => h.event === 'node-blocked');
    expect(blocked).toBeDefined();
    expect(blocked.payload.escape_hatch).toBe(true);
    expect(blocked.payload.reason).toMatch(/unavailable.*aaa-art-director/);
  });

  it('records the verdict with escape_hatch=true (not rejected=true)', () => {
    const tree = mkTree();
    const state = mkState();
    const { history } = applyMutations(
      tree, state, [escapeHatchVerdict()], TS,
      { scannedAgents: new Set() },
    );
    const verdict = history.find((h) => h.event === 'review-verdict');
    expect(verdict).toBeDefined();
    expect(verdict.payload.escape_hatch).toBe(true);
    expect(verdict.payload.rejected).toBeUndefined();
  });

  it('does NOT block on fabricated verdict (non-escape-hatch text)', () => {
    const tree = mkTree();
    const state = mkState();
    const fabricated = {
      kind: 'audit-verdict',
      agent: 'aaa-art-director',
      status: 'GO',
      text: 'looks fine to me',
    };
    const { tree: t2, history } = applyMutations(
      tree, state, [fabricated], TS,
      { scannedAgents: new Set() }, // no Agent dispatch — fabricated
    );
    // Cursor stays in review-pending; fabricated verdict is rejected, not
    // promoted to escape-hatch.
    expect(t2.root.status).toBe('review-pending');
    const verdict = history.find((h) => h.event === 'review-verdict');
    expect(verdict.payload.rejected).toBe(true);
    expect(verdict.payload.escape_hatch).toBeUndefined();
  });

  it('matches "Unavailable" / "UNAVAILABLE" case-insensitively', () => {
    const tree = mkTree();
    const state = mkState();
    const { tree: t2 } = applyMutations(
      tree, state, [escapeHatchVerdict('UNAVAILABLE in this env; please /goal-approve')], TS,
      { scannedAgents: new Set() },
    );
    expect(t2.root.status).toBe('blocked');
  });

  it('matches "  unavailable..." with leading whitespace', () => {
    const tree = mkTree();
    const state = mkState();
    const { tree: t2 } = applyMutations(
      tree, state, [escapeHatchVerdict('  unavailable in environment')], TS,
      { scannedAgents: new Set() },
    );
    expect(t2.root.status).toBe('blocked');
  });

  it('does NOT trigger when status is GO/NOGO even if text says "unavailable"', () => {
    const tree = mkTree();
    const state = mkState();
    const v = { kind: 'audit-verdict', agent: 'aaa-art-director', status: 'NOGO', text: 'unavailable proof of fan animation' };
    const { tree: t2, history } = applyMutations(
      tree, state, [v], TS,
      { scannedAgents: new Set() },
    );
    // Non-REVISE status with "unavailable" prefix → still treated as a real
    // (but fabricated) verdict and rejected. Cursor does NOT auto-block.
    expect(t2.root.status).toBe('review-pending');
    const verdict = history.find((h) => h.event === 'review-verdict');
    expect(verdict.payload.rejected).toBe(true);
  });

  it('does NOT trigger when "unavailable" appears mid-sentence', () => {
    const tree = mkTree();
    const state = mkState();
    const v = escapeHatchVerdict('the timing data is unavailable for this take');
    const { tree: t2, history } = applyMutations(
      tree, state, [v], TS,
      { scannedAgents: new Set() },
    );
    expect(t2.root.status).toBe('review-pending');
    const verdict = history.find((h) => h.event === 'review-verdict');
    expect(verdict.payload.rejected).toBe(true);
  });

  it('handles multiple unavailable reviewers in one batch (combined blocker reason)', () => {
    const tree = mkTree('review-pending', ['aaa-art-director', 'rpg-game-designer']);
    const state = mkState();
    const tags = [
      { kind: 'audit-verdict', agent: 'aaa-art-director', status: 'REVISE', text: 'unavailable; /goal-approve' },
      { kind: 'audit-verdict', agent: 'rpg-game-designer', status: 'REVISE', text: 'unavailable; /goal-approve' },
    ];
    const { tree: t2 } = applyMutations(tree, state, tags, TS, { scannedAgents: new Set() });
    expect(t2.root.status).toBe('blocked');
    expect(t2.root.blocker_reason).toMatch(/aaa-art-director/);
    expect(t2.root.blocker_reason).toMatch(/rpg-game-designer/);
  });

  it('only applies in review-pending state (escape-hatch on pursuing node is parser-only)', () => {
    const tree = mkTree('pursuing');
    const state = mkState();
    const { tree: t2 } = applyMutations(
      tree, state, [escapeHatchVerdict()], TS,
      { scannedAgents: new Set() },
    );
    // applyMutations only consumes audit-verdict tags when status is
    // review-pending; on pursuing, the tag is ignored entirely.
    expect(t2.root.status).toBe('pursuing');
  });
});
