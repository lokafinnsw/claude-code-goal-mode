import { describe, it, expect } from 'vitest';
import { walkLeafTasks, findNodeById, nextPendingTaskAfter } from '../engine/traversal.mjs';

const node = (id, type, status, children = [], extras = {}) => ({
  id, type,
  title: id, goal: id,
  acceptance_criteria: type === 'task' ? ['c'] : [],
  review: [], validate: null, work_front: null,
  status, evidence: [], blocker_reason: null,
  review_attempts: 0, notes: [],
  children, ...extras,
});

describe('walkLeafTasks (pre-order, leaves only)', () => {
  it('returns tasks in pre-order', () => {
    const tree = {
      root: node('s1', 'sprint', 'pending', [
        node('s1.e1', 'epic', 'pending', [
          node('s1.e1.t1', 'task', 'pending'),
          node('s1.e1.t2', 'task', 'pending'),
        ]),
        node('s1.e2', 'epic', 'pending', [
          node('s1.e2.t1', 'task', 'pending'),
        ]),
      ]),
    };
    const ids = walkLeafTasks(tree).map(n => n.id);
    expect(ids).toEqual(['s1.e1.t1', 's1.e1.t2', 's1.e2.t1']);
  });

  it('skips non-task leaves (sprint with no children is not a task)', () => {
    const tree = { root: node('s1', 'sprint', 'pending', []) };
    expect(walkLeafTasks(tree)).toEqual([]);
  });

  it('treats a single-task root as one leaf', () => {
    const tree = { root: node('only', 'task', 'pending') };
    expect(walkLeafTasks(tree).map(n => n.id)).toEqual(['only']);
  });
});

describe('findNodeById', () => {
  it('returns the matching node by id', () => {
    const tree = {
      root: node('a', 'sprint', 'pending', [
        node('a.b', 'epic', 'pending', [node('a.b.c', 'task', 'pending')]),
      ]),
    };
    expect(findNodeById(tree, 'a.b.c').id).toBe('a.b.c');
    expect(findNodeById(tree, 'nope')).toBeNull();
  });
});

describe('nextPendingTaskAfter', () => {
  it('returns the next pending task in pre-order after the given id', () => {
    const tree = {
      root: node('s', 'sprint', 'pending', [
        node('s.t1', 'task', 'achieved'),
        node('s.t2', 'task', 'pending'),
        node('s.t3', 'task', 'pending'),
      ]),
    };
    expect(nextPendingTaskAfter(tree, 's.t2').id).toBe('s.t3');
  });

  it('skips non-pending tasks', () => {
    const tree = {
      root: node('s', 'sprint', 'pending', [
        node('s.t1', 'task', 'pending'),
        node('s.t2', 'task', 'achieved'),
        node('s.t3', 'task', 'blocked'),
        node('s.t4', 'task', 'pending'),
      ]),
    };
    expect(nextPendingTaskAfter(tree, 's.t1').id).toBe('s.t4');
  });

  it('returns null when no pending tasks remain', () => {
    const tree = {
      root: node('s', 'sprint', 'pending', [
        node('s.t1', 'task', 'achieved'),
        node('s.t2', 'task', 'achieved'),
      ]),
    };
    expect(nextPendingTaskAfter(tree, 's.t1')).toBeNull();
  });

  it('returns the first pending task when given id is null', () => {
    const tree = {
      root: node('s', 'sprint', 'pending', [
        node('s.t1', 'task', 'pending'),
        node('s.t2', 'task', 'pending'),
      ]),
    };
    expect(nextPendingTaskAfter(tree, null).id).toBe('s.t1');
  });
});
