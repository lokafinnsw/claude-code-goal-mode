import { describe, it, expect } from 'vitest';
import { applyMutations } from '../engine/apply-mutations.mjs';
import { nextPendingTaskAfter } from '../engine/traversal.mjs';

const mkTree = (taskId = 't', criteria = ['c0', 'c1'], status = 'pursuing') => ({
  schema_version: 1,
  goal_id: 'g',
  mission: 'm',
  created_at: '2026-05-09T00:00:00.000Z',
  approved_at: null,
  root: {
    id: taskId, type: 'task', title: 't', goal: 'g',
    acceptance_criteria: criteria,
    review: [], validate: null, work_front: null,
    status, evidence: [], blocker_reason: null,
    review_attempts: 0, notes: [], children: [],
  },
});

const mkState = (cursor = 't') => ({
  schema_version: 1,
  goal_id: 'g',
  lifecycle: 'pursuing',
  cursor,
  budget: { iterations: { used: 1, max: 100 }, tokens: { used: 0, max: 0 }, wallclock: { started_at: '2026-05-09T00:00:00.000Z', max_seconds: 0 } },
  session_id: 's',
  started_at: '2026-05-09T00:00:00.000Z',
  paused_at: null, ended_at: null, ended_reason: null,
  history: [],
});

describe('applyMutations evidence', () => {
  it('appends evidence to current cursor task', () => {
    const tree = mkTree();
    const state = mkState();
    const tags = [
      { kind: 'evidence', file: 'a', line: null, criterion: 0, note: 'n0', command: null, exit_code: null },
    ];
    const { tree: t2 } = applyMutations(tree, state, tags, '2026-05-09T01:00:00.000Z');
    expect(t2.root.evidence.length).toBe(1);
    expect(t2.root.evidence[0]).toMatchObject({ criterion_index: 0, file: 'a', note: 'n0', iteration: 1 });
  });
});

describe('applyMutations achieved → advance', () => {
  function twoTaskTree() {
    return {
      schema_version: 1, goal_id: 'g', mission: 'm', created_at: '2026-05-09T00:00:00.000Z', approved_at: null,
      root: {
        id: 's', type: 'sprint', title: 's', goal: 'g', acceptance_criteria: [],
        review: [], validate: null, work_front: null, status: 'pursuing',
        evidence: [], blocker_reason: null, review_attempts: 0, notes: [],
        children: [
          { id: 's.t1', type: 'task', title: 't1', goal: 'g', acceptance_criteria: ['c0'], review: [], validate: null, work_front: null, status: 'pursuing', evidence: [], blocker_reason: null, review_attempts: 0, notes: [], children: [] },
          { id: 's.t2', type: 'task', title: 't2', goal: 'g', acceptance_criteria: ['c0'], review: [], validate: null, work_front: null, status: 'pending', evidence: [], blocker_reason: null, review_attempts: 0, notes: [], children: [] },
        ],
      },
    };
  }

  it('advances cursor when criteria are evidence-covered and review[] is empty', () => {
    const tree = twoTaskTree();
    const state = mkState('s.t1');
    const tags = [
      { kind: 'evidence', file: 'x', line: null, criterion: 0, note: 'n', command: null, exit_code: null },
      { kind: 'task-status', value: 'achieved' },
    ];
    const { tree: t2, state: s2 } = applyMutations(tree, state, tags, '2026-05-09T01:00:00.000Z');
    expect(t2.root.children[0].status).toBe('achieved');
    expect(s2.cursor).toBe('s.t2');
  });

  it('keeps task pursuing when criteria are NOT all covered', () => {
    const tree = twoTaskTree();
    tree.root.children[0].acceptance_criteria = ['c0', 'c1'];
    const state = mkState('s.t1');
    const tags = [
      { kind: 'evidence', file: 'x', line: null, criterion: 0, note: 'n', command: null, exit_code: null },
      { kind: 'task-status', value: 'achieved' },
    ];
    const { tree: t2, state: s2 } = applyMutations(tree, state, tags, '2026-05-09T01:00:00.000Z');
    expect(t2.root.children[0].status).toBe('pursuing');
    expect(s2.cursor).toBe('s.t1');
  });
});
