import { describe, it, expect } from 'vitest';
import { GoalTreeSchema } from '../engine/state.mjs';

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
