import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyMutations } from '../engine/apply-mutations.mjs';
import { nextPendingTaskAfter } from '../engine/traversal.mjs';

const mkTree = (taskId = 't', criteria = ['c0', 'c1'], status = 'pursuing') => ({
  schema_version: 2,
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
  schema_version: 2,
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
      schema_version: 2, goal_id: 'g', mission: 'm', created_at: '2026-05-09T00:00:00.000Z', approved_at: null,
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

describe('applyMutations review flow', () => {
  function twoTaskTree() {
    return {
      schema_version: 2, goal_id: 'g', mission: 'm', created_at: '2026-05-09T00:00:00.000Z', approved_at: null,
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

  it('marks review-pending and records review-request', () => {
    const tree = twoTaskTree();
    tree.root.children[0].review = ['art-x', 'design-y'];
    const state = mkState('s.t1');
    const tags = [
      { kind: 'evidence', file: 'x', line: null, criterion: 0, note: 'n', command: null, exit_code: null },
      { kind: 'task-status', value: 'achieved' },
      { kind: 'review-request', agents: ['art-x', 'design-y'] },
    ];
    const { tree: t2, state: s2 } = applyMutations(tree, state, tags, '2026-05-09T01:00:00.000Z');
    expect(t2.root.children[0].status).toBe('review-pending');
    expect(s2.cursor).toBe('s.t1');
  });

  it('advances on all-GO verdicts', () => {
    const tree = twoTaskTree();
    tree.root.children[0].review = ['art-x', 'design-y'];
    tree.root.children[0].status = 'review-pending';
    tree.root.children[0].evidence = [
      { ts: 't', iteration: 1, criterion_index: 0, file: 'x', line: null, commit: null, command: null, exit_code: null, note: 'n' },
    ];
    const state = mkState('s.t1');
    const tags = [
      { kind: 'audit-verdict', agent: 'art-x', status: 'GO', text: 'ok' },
      { kind: 'audit-verdict', agent: 'design-y', status: 'GO', text: 'ok' },
    ];
    const { tree: t2, state: s2 } = applyMutations(tree, state, tags, '2026-05-09T02:00:00.000Z');
    expect(t2.root.children[0].status).toBe('achieved');
    expect(s2.cursor).toBe('s.t2');
  });

  it('returns to pursuing on any NOGO and increments review_attempts', () => {
    const tree = twoTaskTree();
    tree.root.children[0].review = ['art-x'];
    tree.root.children[0].status = 'review-pending';
    tree.root.children[0].review_attempts = 0;
    const state = mkState('s.t1');
    const tags = [
      { kind: 'audit-verdict', agent: 'art-x', status: 'NOGO', text: 'no' },
    ];
    const { tree: t2, state: s2 } = applyMutations(tree, state, tags, '2026-05-09T02:00:00.000Z');
    expect(t2.root.children[0].status).toBe('pursuing');
    expect(t2.root.children[0].review_attempts).toBe(1);
    expect(s2.cursor).toBe('s.t1');
  });

  it('marks node blocked after 3 consecutive NOGO cycles', () => {
    const tree = twoTaskTree();
    tree.root.children[0].review = ['art-x'];
    tree.root.children[0].status = 'review-pending';
    tree.root.children[0].review_attempts = 2;
    const state = mkState('s.t1');
    const tags = [
      { kind: 'audit-verdict', agent: 'art-x', status: 'NOGO', text: 'still no' },
    ];
    const { tree: t2 } = applyMutations(tree, state, tags, '2026-05-09T02:00:00.000Z');
    expect(t2.root.children[0].review_attempts).toBe(3);
    expect(t2.root.children[0].status).toBe('blocked');
  });
});

describe('applyMutations terminal lifecycle', () => {
  function twoTaskTree() {
    return {
      schema_version: 2, goal_id: 'g', mission: 'm', created_at: '2026-05-09T00:00:00.000Z', approved_at: null,
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

  it('marks lifecycle achieved when DFS exhausts pending tasks', () => {
    const tree = twoTaskTree();
    tree.root.children[0].status = 'achieved';
    tree.root.children[1].acceptance_criteria = ['c0'];
    const state = mkState('s.t2');
    const tags = [
      { kind: 'evidence', file: 'x', line: null, criterion: 0, note: 'n', command: null, exit_code: null },
      { kind: 'task-status', value: 'achieved' },
    ];
    const { state: s2 } = applyMutations(tree, state, tags, '2026-05-09T03:00:00.000Z');
    expect(s2.lifecycle).toBe('achieved');
  });

  it('marks lifecycle unmet when 3 consecutive blocked iterations on same node', () => {
    const tree = twoTaskTree();
    tree.root.children[0].status = 'blocked';
    tree.root.children[0].review_attempts = 3;
    const state = mkState('s.t1');
    state.history = [
      { ts: 't', iteration: 1, event: 'node-blocked', node_id: 's.t1', payload: {} },
      { ts: 't', iteration: 2, event: 'node-blocked', node_id: 's.t1', payload: {} },
    ];
    const tags = [
      { kind: 'task-status', value: 'blocked' },
      { kind: 'blocker', reason: 'still stuck' },
    ];
    const { state: s2 } = applyMutations(tree, state, tags, '2026-05-09T03:00:00.000Z');
    expect(s2.lifecycle).toBe('unmet');
  });
});

describe('applyMutations hardening fix-ups', () => {
  function singleTaskTree(criteria = ['c0']) {
    return {
      schema_version: 2, goal_id: 'g', mission: 'm', created_at: '2026-05-09T00:00:00.000Z', approved_at: null,
      root: { id: 't', type: 'task', title: 't', goal: 'g', acceptance_criteria: criteria, review: [], validate: null, work_front: null, status: 'pursuing', evidence: [], blocker_reason: null, review_attempts: 0, notes: [], children: [] },
    };
  }

  function reviewTaskTree(reviewers = ['art-x', 'design-y']) {
    return {
      schema_version: 2, goal_id: 'g', mission: 'm', created_at: '2026-05-09T00:00:00.000Z', approved_at: null,
      root: {
        id: 's', type: 'sprint', title: 's', goal: 'g', acceptance_criteria: [],
        review: [], validate: null, work_front: null, status: 'pursuing',
        evidence: [], blocker_reason: null, review_attempts: 0, notes: [],
        children: [
          { id: 's.t1', type: 'task', title: 't1', goal: 'g', acceptance_criteria: ['c0'], review: reviewers, validate: null, work_front: null, status: 'review-pending', evidence: [{ ts: 't', iteration: 1, criterion_index: 0, file: 'x', line: null, commit: null, command: null, exit_code: null, note: 'n' }], blocker_reason: null, review_attempts: 0, notes: [], children: [] },
          { id: 's.t2', type: 'task', title: 't2', goal: 'g', acceptance_criteria: ['c0'], review: [], validate: null, work_front: null, status: 'pending', evidence: [], blocker_reason: null, review_attempts: 0, notes: [], children: [] },
        ],
      },
    };
  }

  // I3: NOGO wins over GO in mixed batch
  it('NOGO wins over GO when same agent emits both in one batch (I3)', () => {
    const tree = reviewTaskTree(['art-x']);
    const state = mkState('s.t1');
    const tags = [
      { kind: 'audit-verdict', agent: 'art-x', status: 'NOGO', text: 'no' },
      { kind: 'audit-verdict', agent: 'art-x', status: 'GO', text: 'jk yes' },
    ];
    const { tree: t2 } = applyMutations(tree, state, tags, '2026-05-09T02:00:00.000Z');
    expect(t2.root.children[0].status).toBe('pursuing');
    expect(t2.root.children[0].review_attempts).toBe(1);
  });

  it('NOGO wins over GO when different required agents disagree (I3)', () => {
    const tree = reviewTaskTree(['art-x', 'design-y']);
    const state = mkState('s.t1');
    const tags = [
      { kind: 'audit-verdict', agent: 'art-x', status: 'GO', text: 'ok' },
      { kind: 'audit-verdict', agent: 'design-y', status: 'NOGO', text: 'no' },
    ];
    const { tree: t2 } = applyMutations(tree, state, tags, '2026-05-09T02:00:00.000Z');
    expect(t2.root.children[0].status).toBe('pursuing');
  });

  // I2: task-status:blocked increments review_attempts; chains into unmet via I1
  it('task-status:blocked increments review_attempts (I2)', () => {
    const tree = singleTaskTree();
    const state = mkState('t');
    const tags = [
      { kind: 'task-status', value: 'blocked' },
      { kind: 'blocker', reason: 'cannot find file' },
    ];
    const { tree: t2 } = applyMutations(tree, state, tags, '2026-05-09T02:00:00.000Z');
    expect(t2.root.review_attempts).toBe(1);
    expect(t2.root.status).toBe('blocked');
    expect(t2.root.blocker_reason).toBe('cannot find file');
  });

  it('three task-status:blocked iterations escalate to lifecycle unmet (I1+I2)', () => {
    // Three calls in sequence simulating three iterations.
    let tree = singleTaskTree();
    let state = mkState('t');
    const blockTags = [
      { kind: 'task-status', value: 'blocked' },
      { kind: 'blocker', reason: 'still stuck' },
    ];
    for (let i = 1; i <= 3; i++) {
      state.budget.iterations.used = i;
      const r = applyMutations(tree, state, blockTags, `2026-05-09T0${i}:00:00.000Z`);
      tree = r.tree;
      state = r.state;
    }
    expect(tree.root.review_attempts).toBe(3);
    expect(tree.root.status).toBe('blocked');
    expect(state.lifecycle).toBe('unmet');
    expect(state.ended_reason).toBe('3 consecutive blocks on the same node');
  });

  // I1: unmet fires under interleaved events (the case the slice(-2) impl missed)
  it('unmet fires correctly even with intervening evidence-added events (I1)', () => {
    // Iteration 1: 3 NOGO verdicts in a row (with evidence between them).
    let tree = reviewTaskTree(['art-x']);
    tree.root.children[0].review_attempts = 0;
    let state = mkState('s.t1');
    state.budget.iterations.used = 1;
    let r = applyMutations(tree, state, [
      { kind: 'audit-verdict', agent: 'art-x', status: 'NOGO', text: 'no1' },
    ], '2026-05-09T01:00:00.000Z');
    tree = r.tree; state = r.state;
    expect(tree.root.children[0].review_attempts).toBe(1);

    // Iteration 2: agent emits some evidence (interleaved event), then a NOGO.
    state.budget.iterations.used = 2;
    // Re-stage to review-pending for the next verdict batch.
    tree.root.children[0].status = 'review-pending';
    r = applyMutations(tree, state, [
      { kind: 'evidence', file: 'x', line: null, criterion: 0, note: 'progress', command: null, exit_code: null },
      { kind: 'audit-verdict', agent: 'art-x', status: 'NOGO', text: 'still no' },
    ], '2026-05-09T02:00:00.000Z');
    tree = r.tree; state = r.state;
    expect(tree.root.children[0].review_attempts).toBe(2);

    // Iteration 3: third NOGO triggers the auto-block; lifecycle unmet should fire.
    state.budget.iterations.used = 3;
    tree.root.children[0].status = 'review-pending';
    // Cursor must be on the now-blocked node for the unmet check to find it.
    state.cursor = 's.t1';
    r = applyMutations(tree, state, [
      { kind: 'audit-verdict', agent: 'art-x', status: 'NOGO', text: 'final no' },
    ], '2026-05-09T03:00:00.000Z');
    tree = r.tree; state = r.state;
    expect(tree.root.children[0].review_attempts).toBe(3);
    expect(tree.root.children[0].status).toBe('blocked');
    expect(state.lifecycle).toBe('unmet');
  });

  // High-value invariants from the gap catalog:

  // Empty acceptance_criteria + achieved → auto-advance (zero-criteria task)
  it('zero-criterion task advances on task-status:achieved', () => {
    const tree = singleTaskTree([]);
    const state = mkState('t');
    const { tree: t2, state: s2 } = applyMutations(tree, state, [
      { kind: 'task-status', value: 'achieved' },
    ], '2026-05-09T01:00:00.000Z');
    expect(t2.root.status).toBe('achieved');
    expect(s2.lifecycle).toBe('achieved');
  });

  // Empty tags array → no mutations
  it('returns unchanged tree+state for empty tags array', () => {
    const tree = singleTaskTree();
    const state = mkState('t');
    const { tree: t2, state: s2, history } = applyMutations(tree, state, [], '2026-05-09T01:00:00.000Z');
    expect(t2.root.evidence).toEqual([]);
    expect(t2.root.status).toBe('pursuing');
    expect(s2.lifecycle).toBe('pursuing');
    expect(history).toEqual([]);
  });

  // Cursor not in tree → early return, no-op
  it('returns unchanged when cursor does not match any node', () => {
    const tree = singleTaskTree();
    const state = mkState('does-not-exist');
    const { tree: t2, history } = applyMutations(tree, state, [
      { kind: 'evidence', file: 'x', line: null, criterion: 0, note: 'n', command: null, exit_code: null },
    ], '2026-05-09T01:00:00.000Z');
    expect(t2.root.evidence).toEqual([]);
    expect(history).toEqual([]);
  });

  // Lifecycle non-pursuing → terminal transitions skipped
  it('skips lifecycle transitions when state.lifecycle is not pursuing', () => {
    const tree = singleTaskTree([]);
    const state = mkState('t');
    state.lifecycle = 'paused';
    const { state: s2 } = applyMutations(tree, state, [
      { kind: 'task-status', value: 'achieved' },
    ], '2026-05-09T01:00:00.000Z');
    expect(s2.lifecycle).toBe('paused');
  });

  // Aliasing: original inputs untouched
  it('does not mutate original tree or state (deep-clone contract)', () => {
    const tree = singleTaskTree();
    const state = mkState('t');
    const treeBefore = JSON.stringify(tree);
    const stateBefore = JSON.stringify(state);
    applyMutations(tree, state, [
      { kind: 'evidence', file: 'x', line: null, criterion: 0, note: 'n', command: null, exit_code: null },
      { kind: 'task-status', value: 'achieved' },
    ], '2026-05-09T01:00:00.000Z');
    expect(JSON.stringify(tree)).toBe(treeBefore);
    expect(JSON.stringify(state)).toBe(stateBefore);
  });
});

describe('applyMutations audit persistence', () => {
  function twoTaskTree() {
    return {
      schema_version: 2, goal_id: 'g', mission: 'm', created_at: '2026-05-09T00:00:00.000Z', approved_at: null,
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

  it('writes one JSON file per audit-verdict to opts.auditsDir', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-'));
    const tree = twoTaskTree();
    tree.root.children[0].review = ['art-x'];
    tree.root.children[0].status = 'review-pending';
    tree.root.children[0].evidence = [
      { ts: 't', iteration: 1, criterion_index: 0, file: 'x', line: null, commit: null, command: null, exit_code: null, note: 'n' },
    ];
    const state = mkState('s.t1');
    const tags = [{ kind: 'audit-verdict', agent: 'art-x', status: 'GO', text: 'ok' }];

    applyMutations(tree, state, tags, '2026-05-09T01:00:00.000Z', {
      auditsDir: path.join(root, 'audits'),
    });

    const files = fs.readdirSync(path.join(root, 'audits'));
    expect(files.length).toBe(1);
    expect(files[0]).toMatch(/^s\.t1-/);
    expect(files[0]).toContain('art-x');
    const body = JSON.parse(fs.readFileSync(path.join(root, 'audits', files[0]), 'utf8'));
    expect(body).toMatchObject({
      agent: 'art-x',
      status: 'GO',
      text: 'ok',
      kind: 'audit-verdict',
      node_id: 's.t1',
    });
    expect(body.ts).toBe('2026-05-09T01:00:00.000Z');
  });

  it('writes one file per agent when multiple verdicts in one batch', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-multi-'));
    const tree = twoTaskTree();
    tree.root.children[0].review = ['art-x', 'design-y'];
    tree.root.children[0].status = 'review-pending';
    tree.root.children[0].evidence = [
      { ts: 't', iteration: 1, criterion_index: 0, file: 'x', line: null, commit: null, command: null, exit_code: null, note: 'n' },
    ];
    const state = mkState('s.t1');
    const tags = [
      { kind: 'audit-verdict', agent: 'art-x', status: 'GO', text: 'ok' },
      { kind: 'audit-verdict', agent: 'design-y', status: 'GO', text: 'approved' },
    ];

    applyMutations(tree, state, tags, '2026-05-09T01:00:00.000Z', {
      auditsDir: path.join(root, 'audits'),
    });

    const files = fs.readdirSync(path.join(root, 'audits'));
    expect(files.length).toBe(2);
    const agents = files.map(f => f.includes('art-x') ? 'art-x' : 'design-y').sort();
    expect(agents).toEqual(['art-x', 'design-y']);
  });

  it('does not write audit files when opts.auditsDir is omitted (backward compat)', () => {
    const tree = twoTaskTree();
    tree.root.children[0].review = ['art-x'];
    tree.root.children[0].status = 'review-pending';
    tree.root.children[0].evidence = [
      { ts: 't', iteration: 1, criterion_index: 0, file: 'x', line: null, commit: null, command: null, exit_code: null, note: 'n' },
    ];
    const state = mkState('s.t1');
    const tags = [{ kind: 'audit-verdict', agent: 'art-x', status: 'GO', text: 'ok' }];

    // No opts → no audit files written; behavior identical to pre-Phase-7.
    const result = applyMutations(tree, state, tags, '2026-05-09T01:00:00.000Z');
    expect(result.tree.root.children[0].status).toBe('achieved');
  });

  it('sanitizes agent and node_id in audit filenames (defensive against user-edited tree)', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-sanitize-'));
    const tree = twoTaskTree();
    tree.root.children[0].id = 's/t1';  // illegal in filename
    tree.root.children[0].review = ['art/director'];
    tree.root.children[0].status = 'review-pending';
    tree.root.children[0].evidence = [
      { ts: 't', iteration: 1, criterion_index: 0, file: 'x', line: null, commit: null, command: null, exit_code: null, note: 'n' },
    ];
    // Cursor is the same id post-sanitization.
    const state = mkState('s/t1');
    // Note: cursor with '/' violates GoalStateSchema's min(1) format-only;
    // walkLeafTasks finds it because the id literal matches. We only test
    // the filename sanitization, not whether the engine accepts these ids
    // upstream of validate-plan.
    const tags = [{ kind: 'audit-verdict', agent: 'art/director', status: 'GO', text: 'ok' }];

    applyMutations(tree, state, tags, '2026-05-09T01:00:00.000Z', {
      auditsDir: path.join(root, 'audits'),
    });

    const files = fs.readdirSync(path.join(root, 'audits'));
    expect(files.length).toBe(1);
    // Filename should have / replaced with _.
    expect(files[0]).not.toContain('/');
    expect(files[0]).toMatch(/^s_t1-/);
    expect(files[0]).toContain('art_director');

    // Body keeps the original unsanitized values.
    const body = JSON.parse(fs.readFileSync(path.join(root, 'audits', files[0]), 'utf8'));
    expect(body.node_id).toBe('s/t1');
    expect(body.agent).toBe('art/director');
  });

  it('Bug B: collapses .. sequences in node_id and agent to prevent traversal escape', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-traversal-'));
    const tree = twoTaskTree();
    tree.root.children[0].id = '../escape';
    tree.root.children[0].review = ['../../bad-agent'];
    tree.root.children[0].status = 'review-pending';
    tree.root.children[0].evidence = [
      { ts: 't', iteration: 1, criterion_index: 0, file: 'x', line: null, commit: null, command: null, exit_code: null, note: 'n' },
    ];
    const state = mkState('../escape');
    const tags = [{ kind: 'audit-verdict', agent: '../../bad-agent', status: 'GO', text: 'ok' }];

    applyMutations(tree, state, tags, '2026-05-09T01:00:00.000Z', {
      auditsDir: path.join(root, 'audits'),
    });

    const files = fs.readdirSync(path.join(root, 'audits'));
    expect(files.length).toBe(1);
    // Filename must contain neither '..' nor '/'.
    expect(files[0]).not.toContain('..');
    expect(files[0]).not.toContain('/');
    // Body keeps original unsanitized values.
    const body = JSON.parse(fs.readFileSync(path.join(root, 'audits', files[0]), 'utf8'));
    expect(body.node_id).toBe('../escape');
    expect(body.agent).toBe('../../bad-agent');
  });
});
