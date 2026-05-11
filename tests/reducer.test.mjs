/**
 * Reducer unit + property tests.
 *
 * Acceptance gate G1.1 (ADR-0001): property-based determinism test verifies
 * that for any sequence of valid events, `reduce(events)` produces a
 * byte-equal {state, tree} on every replay. This is the single fundamental
 * invariant of event-sourcing — without it, every other guarantee fails.
 *
 * Per-kind branch tests verify each of the 15 ADR-0001 event kinds
 * correctly mutates state + tree.
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { ulid } from 'ulid';
import { reduce } from '../engine/reducer.mjs';
import { EVENT_KIND_VALUES } from '../engine/event-payloads.mjs';

// ── Fixtures ───────────────────────────────────────────────────────────────

function makeSkeleton() {
  return {
    schema_version: 2,
    goal_id: 'g',
    mission: 'm',
    created_at: '2026-05-11T10:00:00.000Z',
    approved_at: null,
    root: {
      id: 'sprint-1', type: 'sprint', title: 'S', goal: 'sg',
      acceptance_criteria: ['c'], review: [], validate: null, work_front: null,
      status: 'pending', evidence: [], blocker_reason: null, review_attempts: 0, notes: [],
      children: [{
        id: 'sprint-1.epic-1', type: 'epic', title: 'E', goal: 'eg',
        acceptance_criteria: ['c'], review: [], validate: null, work_front: null,
        status: 'pending', evidence: [], blocker_reason: null, review_attempts: 0, notes: [],
        children: [
          { id: 'sprint-1.epic-1.task-1', type: 'task', title: 'T1', goal: 'tg',
            acceptance_criteria: ['ac0'], review: [], validate: null, work_front: null,
            status: 'pending', evidence: [], blocker_reason: null, review_attempts: 0, notes: [], children: [] },
          { id: 'sprint-1.epic-1.task-2', type: 'task', title: 'T2', goal: 'tg',
            acceptance_criteria: ['ac0'], review: [], validate: null, work_front: null,
            status: 'pending', evidence: [], blocker_reason: null, review_attempts: 0, notes: [], children: [] },
        ],
      }],
    },
  };
}

function evt(kind, payload, seq = 0) {
  return {
    id: ulid(),
    ts: new Date(2026, 4, 11, 10, 0, seq).toISOString(),
    seq,
    goal_id: 'g',
    schema_version: 1,
    kind,
    turn_id: null,
    payload,
  };
}

// ── Per-kind branches (15 events × 1 happy path) ──────────────────────────

describe('reducer per-kind branches', () => {
  it('goal-created seeds tree + sets lifecycle=draft', () => {
    const skel = makeSkeleton();
    const events = [evt('goal-created', {
      goal_id: 'g', mission: 'm', tree_skeleton: skel, created_at: skel.created_at,
    })];
    // Empty-but-valid initial: root has empty children so traversal doesn't NPE.
    const emptyInitial = {
      schema_version: 2, goal_id: '', mission: '',
      created_at: '2026-05-11T10:00:00.000Z', approved_at: null,
      root: {
        id: 'placeholder', type: 'sprint', title: '', goal: '',
        acceptance_criteria: ['c'], review: [], validate: null, work_front: null,
        status: 'pending', evidence: [], blocker_reason: null, review_attempts: 0,
        notes: [], children: [],
      },
    };
    const r = reduce(emptyInitial, events);
    expect(r.state.lifecycle).toBe('draft');
    expect(r.tree.root.id).toBe('sprint-1');
  });

  it('plan-approved sets lifecycle=approved + tree.approved_at', () => {
    const r = reduce(makeSkeleton(), [
      evt('plan-approved', { approved_at: '2026-05-11T11:00:00.000Z' }, 0),
    ]);
    expect(r.state.lifecycle).toBe('approved');
    expect(r.tree.approved_at).toBe('2026-05-11T11:00:00.000Z');
  });

  it('started seeds session_id, budget, cursor, lifecycle=pursuing', () => {
    const r = reduce(makeSkeleton(), [
      evt('started', {
        session_id: 'sess-xyz', cursor: 'sprint-1.epic-1.task-1',
        started_at: '2026-05-11T11:00:00.000Z',
        budget: {
          iterations: { used: 0, max: 100 },
          tokens: { used: 0, max: 1_000_000 },
          wallclock: { started_at: '2026-05-11T11:00:00.000Z', max_seconds: 86400 },
        },
      }, 0),
    ]);
    expect(r.state.session_id).toBe('sess-xyz');
    expect(r.state.lifecycle).toBe('pursuing');
    expect(r.state.budget.iterations.max).toBe(100);
    expect(r.state.cursor).toBe('sprint-1.epic-1.task-1');
  });

  it('iteration-began updates iteration counter', () => {
    const r = reduce(makeSkeleton(), [
      evt('iteration-began', { iteration: 5, cursor: 'sprint-1.epic-1.task-1' }, 0),
    ]);
    expect(r.state.budget.iterations.used).toBe(5);
  });

  it('evidence-added appends to node.evidence', () => {
    const r = reduce(makeSkeleton(), [
      evt('evidence-added', {
        cursor: 'sprint-1.epic-1.task-1',
        criterion_index: 0, note: 'done', file: 'src/x.ts',
      }, 0),
    ]);
    const node = r.tree.root.children[0].children[0];
    expect(node.evidence).toHaveLength(1);
    expect(node.evidence[0].note).toBe('done');
  });

  it('task-status-asserted sets node.status', () => {
    const r = reduce(makeSkeleton(), [
      evt('task-status-asserted', {
        cursor: 'sprint-1.epic-1.task-1', value: 'pursuing',
      }, 0),
    ]);
    expect(r.tree.root.children[0].children[0].status).toBe('pursuing');
  });

  it('cursor-advanced sets from node achieved + updates cursor', () => {
    const r = reduce(makeSkeleton(), [
      evt('cursor-advanced', {
        from: 'sprint-1.epic-1.task-1', to: 'sprint-1.epic-1.task-2',
        reason: 'achieved',
      }, 0),
    ]);
    expect(r.tree.root.children[0].children[0].status).toBe('achieved');
    expect(r.state.cursor).toBe('sprint-1.epic-1.task-2');
  });

  it('review-requested sets node.status=review-pending', () => {
    const r = reduce(makeSkeleton(), [
      evt('review-requested', {
        cursor: 'sprint-1.epic-1.task-1', agents: ['reviewer-x'],
      }, 0),
    ]);
    expect(r.tree.root.children[0].children[0].status).toBe('review-pending');
  });

  it('audit-verdict-received records in state.history', () => {
    const r = reduce(makeSkeleton(), [
      evt('audit-verdict-received', {
        cursor: 'sprint-1.epic-1.task-1', agent: 'x', status: 'GO', text: 'ok',
      }, 0),
    ]);
    expect(r.state.history.some((h) => h.event === 'review-verdict')).toBe(true);
  });

  it('node-blocked sets status + blocker_reason + review_attempts', () => {
    const r = reduce(makeSkeleton(), [
      evt('node-blocked', {
        cursor: 'sprint-1.epic-1.task-1', reason: 'broken', review_attempts: 2,
      }, 0),
    ]);
    const node = r.tree.root.children[0].children[0];
    expect(node.status).toBe('blocked');
    expect(node.blocker_reason).toBe('broken');
    expect(node.review_attempts).toBe(2);
  });

  it('lifecycle-changed paused → resumed → achieved', () => {
    const r = reduce(makeSkeleton(), [
      evt('lifecycle-changed', { from: 'pursuing', to: 'paused' }, 0),
      evt('lifecycle-changed', { from: 'paused', to: 'pursuing' }, 1),
      evt('lifecycle-changed', { from: 'pursuing', to: 'achieved', reason: 'done' }, 2),
    ]);
    expect(r.state.lifecycle).toBe('achieved');
    expect(r.state.ended_reason).toBe('done');
  });

  it('budget-tally updates counters', () => {
    const r = reduce(makeSkeleton(), [
      evt('budget-tally', {
        iterations: { used: 10, max: 100 },
        tokens: { used: 5000, max: 1_000_000 },
        wallclock: { elapsed_seconds: 600, max_seconds: 86400 },
      }, 0),
    ]);
    expect(r.state.budget.iterations.used).toBe(10);
    expect(r.state.budget.tokens.used).toBe(5000);
  });

  it('budget-exhausted sets lifecycle=budget-limited', () => {
    const r = reduce(makeSkeleton(), [
      evt('budget-exhausted', { which: 'iterations', used: 100, max: 100 }, 0),
    ]);
    expect(r.state.lifecycle).toBe('budget-limited');
    expect(r.state.ended_reason).toContain('iterations');
  });

  it('manual-approve-applied achieves node + advances cursor', () => {
    const r = reduce(makeSkeleton(), [
      evt('manual-approve-applied', {
        cursor: 'sprint-1.epic-1.task-1', reason: 'unavailable reviewer', user: 'andre',
      }, 0),
    ]);
    expect(r.tree.root.children[0].children[0].status).toBe('achieved');
    expect(r.state.cursor).toBe('sprint-1.epic-1.task-2');
  });

  it('cleared marks lifecycle=unmet + records reason', () => {
    const r = reduce(makeSkeleton(), [
      evt('cleared', { archived_to: '/tmp/archive' }, 0),
    ]);
    expect(r.state.lifecycle).toBe('unmet');
    expect(r.state.ended_reason).toContain('archive');
  });
});

// ── Property: deterministic replay (ADR-0001 acceptance gate G1.1) ────────

describe('reducer determinism (G1.1)', () => {
  it('replaying the same event sequence twice produces byte-equal state', () => {
    fc.assert(
      fc.property(
        validEventSequence(),
        (events) => {
          const a = reduce(makeSkeleton(), events);
          const b = reduce(makeSkeleton(), events);
          // Deep-equal via JSON serialization. Both must agree.
          expect(JSON.stringify(a.state)).toBe(JSON.stringify(b.state));
          expect(JSON.stringify(a.tree)).toBe(JSON.stringify(b.tree));
        },
      ),
      { numRuns: 50 },
    );
  });

  it('prefix replay + tail replay equals full replay', () => {
    fc.assert(
      fc.property(
        validEventSequence(),
        (events) => {
          if (events.length < 2) return;
          const mid = Math.floor(events.length / 2);
          const prefix = events.slice(0, mid);
          const tail = events.slice(mid);

          const full = reduce(makeSkeleton(), events);
          const half = reduce(makeSkeleton(), prefix);
          const fromHalf = reduce(half.tree, tail, half.state);

          expect(JSON.stringify(fromHalf.state)).toBe(JSON.stringify(full.state));
          expect(JSON.stringify(fromHalf.tree)).toBe(JSON.stringify(full.tree));
        },
      ),
      { numRuns: 50 },
    );
  });
});

function validEventSequence() {
  // Generate sequences from a constrained subset of kinds — the property test
  // verifies determinism, not full state-machine validity. Order of kinds is
  // randomised; payloads are well-formed for each kind.
  const cursors = ['sprint-1.epic-1.task-1', 'sprint-1.epic-1.task-2'];
  return fc.array(
    fc.oneof(
      // budget-tally with bounded counters
      fc.tuple(fc.integer({ min: 0, max: 100 }), fc.integer({ min: 0, max: 10000 }))
        .map(([iter, tok]) => ({
          kind: 'budget-tally',
          payload: {
            iterations: { used: iter, max: 200 },
            tokens: { used: tok, max: 1_000_000 },
            wallclock: { elapsed_seconds: iter * 60, max_seconds: 86400 },
          },
        })),
      // evidence-added
      fc.tuple(fc.constantFrom(...cursors), fc.integer({ min: 0, max: 5 }), fc.string({ minLength: 1 }))
        .map(([cursor, criterion, note]) => ({
          kind: 'evidence-added',
          payload: { cursor, criterion_index: criterion, note },
        })),
      // task-status-asserted
      fc.tuple(fc.constantFrom(...cursors), fc.constantFrom('pursuing', 'achieved', 'blocked'))
        .map(([cursor, value]) => ({
          kind: 'task-status-asserted',
          payload: { cursor, value, blocker_reason: value === 'blocked' ? 'auto' : null },
        })),
      // review-requested
      fc.constantFrom(...cursors)
        .map((cursor) => ({
          kind: 'review-requested',
          payload: { cursor, agents: ['art', 'design'] },
        })),
    ),
    { minLength: 0, maxLength: 50 },
  ).map((rawEvents) => rawEvents.map((e, i) => ({
    id: `id-${i}`,
    ts: new Date(2026, 4, 11, 10, 0, i).toISOString(),
    seq: i,
    goal_id: 'g',
    schema_version: 1,
    kind: e.kind,
    turn_id: null,
    payload: e.payload,
  })));
}

// ── Reducer purity: no I/O, no clock, no random ───────────────────────────

describe('reducer is pure', () => {
  it('same input + same Date stub produces same output', () => {
    // Save current Date.now
    const originalNow = Date.now;
    let nowVal = 1700000000000;
    Date.now = () => nowVal;
    Math.random = () => 0.5;
    try {
      const events = [evt('cursor-advanced', {
        from: 'sprint-1.epic-1.task-1', to: 'sprint-1.epic-1.task-2', reason: 'achieved',
      }, 0)];
      const a = reduce(makeSkeleton(), events);
      // Advance time + run again — output must be identical.
      nowVal = 1800000000000;
      const b = reduce(makeSkeleton(), events);
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    } finally {
      Date.now = originalNow;
    }
  });
});
