import { describe, it, expect } from 'vitest';
import { renderStatus } from '../engine/render-status.mjs';

const sampleTree = () => ({
  goal_id: 'g',
  root: {
    id: 's', type: 'sprint', title: 'Sprint 1', goal: '',
    acceptance_criteria: [], review: [], validate: null,
    work_front: null, status: 'pursuing',
    evidence: [], blocker_reason: null, review_attempts: 0, notes: [],
    children: [
      {
        id: 's.t1', type: 'task', title: 'T1', goal: '',
        acceptance_criteria: ['c'], review: [], validate: null,
        work_front: null, status: 'achieved',
        evidence: [], blocker_reason: null, review_attempts: 0, notes: [],
        children: [],
      },
      {
        id: 's.t2', type: 'task', title: 'T2', goal: '',
        acceptance_criteria: ['c'], review: [], validate: null,
        work_front: null, status: 'pursuing',
        evidence: [], blocker_reason: null, review_attempts: 0, notes: [],
        children: [],
      },
    ],
  },
});

const sampleState = (now = Date.now()) => ({
  lifecycle: 'pursuing',
  cursor: 's.t2',
  budget: {
    iterations: { used: 5, max: 100 },
    tokens: { used: 12345, max: 1000000 },
    wallclock: { started_at: new Date(now - 600000).toISOString(), max_seconds: 14400 },
  },
  history: [{ ts: 't', iteration: 5, event: 'started', node_id: 's.t1', payload: {} }],
});

describe('renderStatus', () => {
  it('renders tree with status icons and budget bars', () => {
    const out = renderStatus(sampleTree(), sampleState());
    expect(out).toContain('🟡');     // pursuing icon for s.t2 (and root sprint)
    expect(out).toContain('✅');     // achieved icon for s.t1
    expect(out).toContain('s.t2 ◀ cursor');
    expect(out).toContain('Iterations:');
    expect(out).toContain('Tokens:');
    expect(out).toContain('Wall-clock:');
  });

  it('shows lifecycle in heading', () => {
    const out = renderStatus(sampleTree(), sampleState());
    expect(out).toMatch(/lifecycle: pursuing/);
  });

  it('shows infinity bar when max=0', () => {
    const tree = sampleTree();
    const state = sampleState();
    state.budget.iterations.max = 0;
    const out = renderStatus(tree, state);
    expect(out).toContain('∞');
  });

  it('lists last 3 history events', () => {
    const tree = sampleTree();
    const state = sampleState();
    state.history = [
      { ts: '2026-05-09T01:00:00Z', iteration: 1, event: 'started', node_id: 's.t1', payload: {} },
      { ts: '2026-05-09T02:00:00Z', iteration: 2, event: 'evidence-added', node_id: 's.t1', payload: {} },
      { ts: '2026-05-09T03:00:00Z', iteration: 3, event: 'cursor-advanced', node_id: 's.t1', payload: {} },
      { ts: '2026-05-09T04:00:00Z', iteration: 4, event: 'review-requested', node_id: 's.t2', payload: {} },
    ];
    const out = renderStatus(tree, state);
    // Last 3 events: evidence-added, cursor-advanced, review-requested.
    expect(out).toContain('evidence-added');
    expect(out).toContain('cursor-advanced');
    expect(out).toContain('review-requested');
    expect(out).not.toContain('started s.t1');  // dropped (older than last 3)
  });

  it('renders nested tree depth correctly', () => {
    const tree = sampleTree();
    const out = renderStatus(tree, sampleState());
    // Children should be indented under parent.
    const lines = out.split('\n');
    const sprintLine = lines.find(l => l.includes('s — Sprint 1'));
    const t1Line = lines.find(l => l.includes('s.t1'));
    // sprint at depth 0, children at depth 1 (2-space indent).
    expect(sprintLine.startsWith(' ')).toBe(false);
    expect(t1Line.startsWith('  ')).toBe(true);
  });

  it('accepts injectable now for deterministic wallclock', () => {
    const tree = sampleTree();
    const state = sampleState();
    state.budget.wallclock.started_at = '2026-05-09T22:00:00.000Z';
    const now = new Date('2026-05-09T22:30:00.000Z').getTime();
    const out = renderStatus(tree, state, now);
    // 30 minutes elapsed.
    expect(out).toContain('30/240');
  });
});
