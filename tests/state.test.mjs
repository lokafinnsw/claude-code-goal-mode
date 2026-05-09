import { describe, it, expect } from 'vitest';
import { GoalTreeSchema, GoalStateSchema } from '../engine/state.mjs';

describe('GoalTreeSchema', () => {
  it('accepts a minimal valid tree', () => {
    const tree = {
      schema_version: 1,
      goal_id: 'demo',
      mission: 'demo mission',
      created_at: '2026-05-09T00:00:00.000Z',
      approved_at: null,
      root: {
        id: 'sprint-1',
        type: 'sprint',
        title: 'Root sprint',
        goal: 'Top-line outcome',
        acceptance_criteria: [],
        review: [],
        validate: null,
        work_front: null,
        status: 'pending',
        evidence: [],
        blocker_reason: null,
        review_attempts: 0,
        notes: [],
        children: [
          {
            id: 'sprint-1.task-1',
            type: 'task',
            title: 'Leaf task',
            goal: 'Make it green',
            acceptance_criteria: ['criterion A'],
            review: [],
            validate: null,
            work_front: null,
            status: 'pending',
            evidence: [],
            blocker_reason: null,
            review_attempts: 0,
            notes: [],
            children: [],
          },
        ],
      },
    };
    expect(() => GoalTreeSchema.parse(tree)).not.toThrow();
  });

  it('rejects a task with empty acceptance_criteria', () => {
    const tree = {
      schema_version: 1,
      goal_id: 'demo',
      mission: 'demo',
      created_at: '2026-05-09T00:00:00.000Z',
      approved_at: null,
      root: {
        id: 'task-1',
        type: 'task',
        title: 'orphan task',
        goal: 'g',
        acceptance_criteria: [],
        review: [],
        validate: null,
        work_front: null,
        status: 'pending',
        evidence: [],
        blocker_reason: null,
        review_attempts: 0,
        notes: [],
        children: [],
      },
    };
    expect(() => GoalTreeSchema.parse(tree)).toThrow(/acceptance_criteria/);
  });

  it('rejects unknown status enum', () => {
    const tree = {
      schema_version: 1,
      goal_id: 'demo',
      mission: 'demo',
      created_at: '2026-05-09T00:00:00.000Z',
      approved_at: null,
      root: {
        id: 'sprint-1',
        type: 'sprint',
        title: 'r',
        goal: 'g',
        acceptance_criteria: [],
        review: [],
        validate: null,
        work_front: null,
        status: 'wat',
        evidence: [],
        blocker_reason: null,
        review_attempts: 0,
        notes: [],
        children: [],
      },
    };
    expect(() => GoalTreeSchema.parse(tree)).toThrow();
  });
});

describe('GoalStateSchema', () => {
  it('accepts a minimal valid state', () => {
    const state = {
      schema_version: 1,
      goal_id: 'demo',
      lifecycle: 'draft',
      cursor: 'sprint-1',
      budget: {
        iterations: { used: 0, max: 100 },
        tokens: { used: 0, max: 2000000 },
        wallclock: { started_at: '2026-05-09T00:00:00.000Z', max_seconds: 14400 },
      },
      session_id: 'session-abc',
      started_at: null,
      paused_at: null,
      ended_at: null,
      ended_reason: null,
      history: [],
    };
    expect(() => GoalStateSchema.parse(state)).not.toThrow();
  });

  it('rejects unknown lifecycle', () => {
    const state = {
      schema_version: 1,
      goal_id: 'd',
      lifecycle: 'wat',
      cursor: 'a',
      budget: {
        iterations: { used: 0, max: 0 },
        tokens: { used: 0, max: 0 },
        wallclock: { started_at: '2026-05-09T00:00:00.000Z', max_seconds: 0 },
      },
      session_id: 's',
      started_at: null,
      paused_at: null,
      ended_at: null,
      ended_reason: null,
      history: [],
    };
    expect(() => GoalStateSchema.parse(state)).toThrow();
  });

  it('rejects empty cursor', () => {
    const state = {
      schema_version: 1,
      goal_id: 'd',
      lifecycle: 'draft',
      cursor: '',
      budget: {
        iterations: { used: 0, max: 0 },
        tokens: { used: 0, max: 0 },
        wallclock: { started_at: '2026-05-09T00:00:00.000Z', max_seconds: 0 },
      },
      session_id: 's',
      started_at: null,
      paused_at: null,
      ended_at: null,
      ended_reason: null,
      history: [],
    };
    expect(() => GoalStateSchema.parse(state)).toThrow();
  });
});
