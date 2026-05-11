import { describe, it, expect } from 'vitest';
import { computeProgress } from '../engine/progress.mjs';

function makeTree(spec) {
  // spec = [{epicId, tasks: [{id, status}]}, ...]
  const epics = spec.map(({ epicId, tasks }) => ({
    id: epicId,
    type: 'epic',
    title: `Epic ${epicId}`,
    goal: 'g',
    acceptance_criteria: ['c'],
    review: [],
    validate: null,
    work_front: null,
    status: 'pending',
    evidence: [],
    blocker_reason: null,
    review_attempts: 0,
    notes: [],
    children: tasks.map((t) => ({
      id: t.id,
      type: 'task',
      title: t.id,
      goal: 'tg',
      acceptance_criteria: ['ac'],
      review: [],
      validate: null,
      work_front: null,
      status: t.status,
      evidence: [],
      blocker_reason: null,
      review_attempts: 0,
      notes: [],
      children: [],
    })),
  }));
  return {
    schema_version: 2,
    goal_id: 'g',
    mission: 'm',
    created_at: new Date().toISOString(),
    approved_at: new Date().toISOString(),
    root: {
      id: 'sprint-1',
      type: 'sprint',
      title: 'Sprint 1',
      goal: 'sg',
      acceptance_criteria: ['c'],
      review: [],
      validate: null,
      work_front: null,
      status: 'pending',
      evidence: [],
      blocker_reason: null,
      review_attempts: 0,
      notes: [],
      children: epics,
    },
  };
}

describe('computeProgress', () => {
  it('empty tree returns zero counters and a no-plan block', () => {
    const r = computeProgress({}, null);
    expect(r.overall.total).toBe(0);
    expect(r.block).toContain('no plan loaded');
  });

  it('single all-pending tree reports 0% overall', () => {
    const tree = makeTree([
      { epicId: 'sprint-1.epic-1', tasks: [{ id: 'sprint-1.epic-1.task-1', status: 'pending' }] },
    ]);
    const r = computeProgress(tree, 'sprint-1.epic-1.task-1');
    expect(r.overall.done).toBe(0);
    expect(r.overall.total).toBe(1);
    expect(r.overall.pct).toBe(0);
  });

  it('mixed-status tree counts only achieved tasks', () => {
    const tree = makeTree([
      {
        epicId: 'sprint-1.epic-1',
        tasks: [
          { id: 'sprint-1.epic-1.task-1', status: 'achieved' },
          { id: 'sprint-1.epic-1.task-2', status: 'pursuing' },
          { id: 'sprint-1.epic-1.task-3', status: 'pending' },
        ],
      },
    ]);
    const r = computeProgress(tree, 'sprint-1.epic-1.task-2');
    expect(r.overall).toMatchObject({ done: 1, total: 3, pct: 33 });
    expect(r.task.index).toBe(2); // 1-indexed
    expect(r.task.total).toBe(3);
    expect(r.task.title).toBe('sprint-1.epic-1.task-2');
  });

  it('all-tasks-achieved in an epic counts that epic as done', () => {
    const tree = makeTree([
      {
        epicId: 'sprint-1.epic-1',
        tasks: [
          { id: 'sprint-1.epic-1.task-1', status: 'achieved' },
          { id: 'sprint-1.epic-1.task-2', status: 'achieved' },
        ],
      },
      {
        epicId: 'sprint-1.epic-2',
        tasks: [{ id: 'sprint-1.epic-2.task-1', status: 'pending' }],
      },
    ]);
    const r = computeProgress(tree, 'sprint-1.epic-2.task-1');
    expect(r.epic.done).toBe(1); // epic-1 done (counted from sprint-1 scope)
    expect(r.epic.total).toBe(2);
  });

  it('all-tasks-achieved in a sprint counts that sprint as done', () => {
    const tree = makeTree([
      {
        epicId: 'sprint-1.epic-1',
        tasks: [
          { id: 'sprint-1.epic-1.task-1', status: 'achieved' },
          { id: 'sprint-1.epic-1.task-2', status: 'achieved' },
        ],
      },
    ]);
    const r = computeProgress(tree, 'sprint-1.epic-1.task-2');
    expect(r.sprint.done).toBe(1);
    expect(r.sprint.total).toBe(1);
    expect(r.sprint.pct).toBe(100);
  });

  it('cursor pointing at a sprint does not throw, returns whole-tree counters', () => {
    const tree = makeTree([
      { epicId: 'sprint-1.epic-1', tasks: [{ id: 'sprint-1.epic-1.task-1', status: 'pending' }] },
    ]);
    const r = computeProgress(tree, 'sprint-1');
    expect(r).toBeTruthy();
    expect(r.overall.total).toBe(1);
  });

  it('cursor pointing at an epic does not throw', () => {
    const tree = makeTree([
      { epicId: 'sprint-1.epic-1', tasks: [{ id: 'sprint-1.epic-1.task-1', status: 'pending' }] },
    ]);
    const r = computeProgress(tree, 'sprint-1.epic-1');
    expect(r).toBeTruthy();
    expect(r.task.total).toBe(1);
  });

  it('block string contains all four progress lines', () => {
    const tree = makeTree([
      { epicId: 'sprint-1.epic-1', tasks: [{ id: 'sprint-1.epic-1.task-1', status: 'achieved' }] },
    ]);
    const r = computeProgress(tree, 'sprint-1.epic-1.task-1');
    expect(r.block).toMatch(/Sprint/);
    expect(r.block).toMatch(/Epic/);
    expect(r.block).toMatch(/Task/);
    expect(r.block).toMatch(/Overall/);
    // ASCII bar present
    expect(r.block).toMatch(/[█░]{10}/);
  });

  it('100% overall produces full bars and 100 pct', () => {
    const tree = makeTree([
      {
        epicId: 'sprint-1.epic-1',
        tasks: [
          { id: 'sprint-1.epic-1.task-1', status: 'achieved' },
          { id: 'sprint-1.epic-1.task-2', status: 'achieved' },
        ],
      },
    ]);
    const r = computeProgress(tree, 'sprint-1.epic-1.task-2');
    expect(r.overall.pct).toBe(100);
    expect(r.block).toContain('██████████  100%'); // sprint line fully filled (10/10 bar)
  });
});
