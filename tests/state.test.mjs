import { describe, it, expect } from 'vitest';
import { GoalTreeSchema, GoalStateSchema, loadState, saveState, loadTree, saveTree } from '../engine/state.mjs';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

describe('GoalTreeSchema', () => {
  it('accepts a minimal valid tree', () => {
    const tree = {
      schema_version: 2,
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
      schema_version: 2,
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
      schema_version: 2,
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
      schema_version: 2,
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
      schema_version: 2,
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
      schema_version: 2,
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

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'goal-state-'));
}

describe('atomic save/load', () => {
  it('saveState then loadState round-trips', () => {
    const dir = tmpdir();
    const state = {
      schema_version: 2,
      goal_id: 'g',
      lifecycle: 'draft',
      cursor: 'a',
      budget: {
        iterations: { used: 0, max: 10 },
        tokens: { used: 0, max: 100 },
        wallclock: { started_at: '2026-05-09T00:00:00.000Z', max_seconds: 60 },
      },
      session_id: 's',
      started_at: null,
      paused_at: null,
      ended_at: null,
      ended_reason: null,
      history: [],
    };
    saveState(dir, state);
    const loaded = loadState(dir);
    expect(loaded).toEqual(state);
  });

  it('loadState returns null when file is missing', () => {
    const dir = tmpdir();
    expect(loadState(dir)).toBeNull();
  });

  it('loadState returns null on invalid JSON and writes a .broken backup', () => {
    const dir = tmpdir();
    const target = path.join(dir, '.claude/goals/active/state.json');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'not json');
    expect(loadState(dir)).toBeNull();
    const files = fs.readdirSync(path.dirname(target));
    expect(files.some(f => f.startsWith('state.json.broken-'))).toBe(true);
  });

  it('saveState writes via .tmp and renames atomically', () => {
    const dir = tmpdir();
    const state = {
      schema_version: 2,
      goal_id: 'g',
      lifecycle: 'draft',
      cursor: 'a',
      budget: {
        iterations: { used: 0, max: 10 },
        tokens: { used: 0, max: 100 },
        wallclock: { started_at: '2026-05-09T00:00:00.000Z', max_seconds: 60 },
      },
      session_id: 's',
      started_at: null,
      paused_at: null,
      ended_at: null,
      ended_reason: null,
      history: [],
    };
    saveState(dir, state);
    const target = path.join(dir, '.claude/goals/active/state.json');
    expect(fs.existsSync(target)).toBe(true);
    expect(fs.existsSync(target + '.tmp')).toBe(false);
  });
});

describe('atomic save/load — tree', () => {
  function makeMinimalTree() {
    return {
      schema_version: 2,
      goal_id: 'tree-test',
      mission: 'tree round-trip mission',
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
        status: 'pending',
        evidence: [],
        blocker_reason: null,
        review_attempts: 0,
        notes: [],
        children: [
          {
            id: 'sprint-1.task-1',
            type: 'task',
            title: 'leaf',
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
            children: [],
          },
        ],
      },
    };
  }

  it('saveTree then loadTree round-trips', () => {
    const dir = tmpdir();
    const tree = makeMinimalTree();
    saveTree(dir, tree);
    expect(loadTree(dir)).toEqual(tree);
  });

  it('loadTree returns null when file missing', () => {
    const dir = tmpdir();
    expect(loadTree(dir)).toBeNull();
  });

  it('loadTree returns null on invalid JSON and writes .broken backup', () => {
    const dir = tmpdir();
    const target = path.join(dir, '.claude/goals/active/tree.json');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, '{not valid json');
    expect(loadTree(dir)).toBeNull();
    const files = fs.readdirSync(path.dirname(target));
    expect(files.some(f => f.startsWith('tree.json.broken-'))).toBe(true);
  });
});

describe('readWithBackup forensic-copy collision handling (Bug 2)', () => {
  it('preserves multiple .broken-<ts>-<seq> files when crashes happen in tight sequence', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'broken-collision-'));
    fs.mkdirSync(path.join(root, '.claude/goals/active'), { recursive: true });
    const statePath = path.join(root, '.claude/goals/active/state.json');

    // 5 corrupt-write/read cycles in tight loop. Each load should preserve
    // the corrupt copy under a unique .broken-* name.
    for (let i = 0; i < 5; i++) {
      fs.writeFileSync(statePath, `not valid json #${i}`);
      const result = loadState(root);
      expect(result).toBeNull();  // load fails on corrupt JSON
    }

    // Inspect the active dir for .broken-* files. Expect 5.
    const files = fs.readdirSync(path.join(root, '.claude/goals/active'));
    const brokenFiles = files.filter(f => f.includes('.broken-'));
    expect(brokenFiles.length).toBe(5);
  });
});
