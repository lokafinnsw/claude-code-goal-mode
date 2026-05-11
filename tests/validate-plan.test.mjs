import { describe, it, expect } from 'vitest';
import { validatePlan } from '../engine/validate-plan.mjs';

const okTree = () => ({
  schema_version: 2,
  goal_id: 'g',
  mission: 'm',
  created_at: '2026-05-09T00:00:00.000Z',
  approved_at: null,
  root: {
    id: 's', type: 'sprint', title: 's', goal: 'g',
    acceptance_criteria: [], review: [], validate: null,
    work_front: 'engine', status: 'pending',
    evidence: [], blocker_reason: null, review_attempts: 0, notes: [],
    children: [
      {
        id: 's.t1', type: 'task', title: 't1', goal: 'g',
        acceptance_criteria: ['c'], review: [], validate: 'npm test',
        work_front: 'engine', status: 'pending',
        evidence: [], blocker_reason: null, review_attempts: 0, notes: [],
        children: [],
      },
    ],
  },
});

describe('validatePlan', () => {
  it('passes a valid tree', () => {
    expect(validatePlan(okTree())).toEqual({ ok: true, errors: [], warnings: [] });
  });

  it('rejects placeholder strings in titles', () => {
    const t = okTree();
    t.root.children[0].title = 'TBD';
    const r = validatePlan(t);
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toMatch(/placeholder/i);
  });

  it('rejects placeholder strings in goals', () => {
    const t = okTree();
    t.root.children[0].goal = 'TODO: figure this out';
    const r = validatePlan(t);
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toMatch(/placeholder/i);
  });

  it('rejects placeholder strings in acceptance criteria', () => {
    const t = okTree();
    t.root.children[0].acceptance_criteria = ['FIXME write real criterion'];
    const r = validatePlan(t);
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toMatch(/placeholder/i);
  });

  it('rejects empty acceptance_criteria for a task (caught at schema layer)', () => {
    const t = okTree();
    t.root.children[0].acceptance_criteria = [];
    const r = validatePlan(t);
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatch(/schema/i);  // schema fast-fails before any business-rule check
  });

  it('warns about reviewers not in availability set', () => {
    const t = okTree();
    t.root.children[0].review = ['art-x', 'design-y'];
    const r = validatePlan(t, { availableReviewers: new Set(['art-x']) });
    expect(r.ok).toBe(true);
    expect(r.warnings.join('\n')).toMatch(/design-y/);
    expect(r.warnings.join('\n')).not.toMatch(/art-x/);
  });

  it('does not warn when no availability set is provided (CLI may skip discovery)', () => {
    const t = okTree();
    t.root.children[0].review = ['anything', 'goes'];
    const r = validatePlan(t);
    expect(r.ok).toBe(true);
    expect(r.warnings).toEqual([]);
  });

  it('rejects schema-invalid tree (e.g., missing required field)', () => {
    const t = okTree();
    delete t.root.children[0].title;  // make it schema-invalid
    const r = validatePlan(t);
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatch(/schema/i);
  });

  it('catches placeholders in nested epics and sprints', () => {
    const t = okTree();
    t.root.title = 'TBD';
    const r = validatePlan(t);
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toMatch(/node s/);
  });

  it('catches ??? as a placeholder', () => {
    const t = okTree();
    t.root.children[0].goal = 'do ??? here';
    const r = validatePlan(t);
    expect(r.ok).toBe(false);
  });
});

import { discoverReviewers } from '../engine/approve-plan-cli.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

describe('discoverReviewers', () => {
  it('returns names of subdirectories in the search paths', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'discover-'));
    fs.mkdirSync(path.join(root, 'reviewer-a'));
    fs.mkdirSync(path.join(root, 'reviewer-b'));
    const result = discoverReviewers([root]);
    expect(result.has('reviewer-a')).toBe(true);
    expect(result.has('reviewer-b')).toBe(true);
  });

  it('returns empty set when no search dirs exist', () => {
    const result = discoverReviewers(['/nonexistent/path/abcdef']);
    expect(result.size).toBe(0);
  });

  it('merges across multiple search dirs', () => {
    const dir1 = fs.mkdtempSync(path.join(os.tmpdir(), 'd1-'));
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'd2-'));
    fs.mkdirSync(path.join(dir1, 'a'));
    fs.mkdirSync(path.join(dir2, 'b'));
    const result = discoverReviewers([dir1, dir2]);
    expect(result.size).toBe(2);
    expect(result.has('a')).toBe(true);
    expect(result.has('b')).toBe(true);
  });

  it('dedupes names that appear in multiple dirs', () => {
    const dir1 = fs.mkdtempSync(path.join(os.tmpdir(), 'dup1-'));
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'dup2-'));
    fs.mkdirSync(path.join(dir1, 'shared'));
    fs.mkdirSync(path.join(dir2, 'shared'));
    const result = discoverReviewers([dir1, dir2]);
    expect(result.size).toBe(1);
  });
});

import { approvePlan } from '../engine/approve-plan-cli.mjs';
import { saveState, saveTree, loadState, loadTree } from '../engine/state.mjs';

describe('approvePlan lifecycle gate (C-1)', () => {
  function minimalState(goalId) {
    return {
      schema_version: 2,
      goal_id: goalId,
      lifecycle: 'draft',
      cursor: 'pending',
      budget: {
        iterations: { used: 0, max: 0 },
        tokens: { used: 0, max: 0 },
        wallclock: { started_at: new Date().toISOString(), max_seconds: 0 },
      },
      session_id: 'pending',
      started_at: null,
      paused_at: null,
      ended_at: null,
      ended_reason: null,
      history: [],
    };
  }

  function setup(treeOverrides = {}, stateOverrides = null) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'approve-'));
    const tree = okTree();
    Object.assign(tree, treeOverrides);
    saveTree(root, tree);
    if (stateOverrides) {
      saveState(root, { ...minimalState(tree.goal_id), ...stateOverrides });
    }
    return root;
  }

  it('approves when state is missing (writes fresh state.json with lifecycle=approved)', () => {
    const root = setup();
    const result = approvePlan(root);
    expect(result.ok).toBe(true);
    const state = loadState(root);
    expect(state.lifecycle).toBe('approved');
    expect(state.history[0].event).toBe('plan-approved');
  });

  it('approves when state.lifecycle=draft (transitions to approved)', () => {
    const root = setup({}, { lifecycle: 'draft' });
    const result = approvePlan(root);
    expect(result.ok).toBe(true);
    const state = loadState(root);
    expect(state.lifecycle).toBe('approved');
  });

  it('idempotent re-approval when already approved (re-stamps approved_at)', () => {
    const root = setup({}, { lifecycle: 'approved' });
    const tree1 = loadTree(root);
    tree1.approved_at = '2026-05-09T00:00:00.000Z';
    saveTree(root, tree1);

    const result = approvePlan(root);
    expect(result.ok).toBe(true);

    const tree2 = loadTree(root);
    expect(tree2.approved_at).not.toBe('2026-05-09T00:00:00.000Z');  // re-stamped
  });

  it('refuses when state.lifecycle=pursuing (preserves the run, C-1)', () => {
    const root = setup({}, { lifecycle: 'pursuing', cursor: 's.t1', session_id: 'real-session' });
    const result = approvePlan(root);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatch(/lifecycle=pursuing/);
    expect(result.errors[0]).toMatch(/draft/);
    // State preserved.
    const state = loadState(root);
    expect(state.lifecycle).toBe('pursuing');
    expect(state.session_id).toBe('real-session');
  });

  it('refuses when state.lifecycle=paused (C-1)', () => {
    const root = setup({}, { lifecycle: 'paused', cursor: 's.t1', session_id: 'real-session' });
    const result = approvePlan(root);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatch(/lifecycle=paused/);
  });

  it('refuses when state.lifecycle=achieved (C-1)', () => {
    const root = setup({}, { lifecycle: 'achieved', cursor: 's.t1', session_id: 'real-session' });
    const result = approvePlan(root);
    expect(result.ok).toBe(false);
  });

  it('refuses when state.lifecycle=unmet (C-1)', () => {
    const root = setup({}, { lifecycle: 'unmet', cursor: 's.t1', session_id: 'real-session' });
    const result = approvePlan(root);
    expect(result.ok).toBe(false);
  });

  it('returns error when no tree.json exists', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noplan-'));
    const result = approvePlan(root);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatch(/no tree\.json/i);
  });

  it('returns errors+warnings when validation fails', () => {
    const tree = okTree();
    tree.root.children[0].title = 'TBD';
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'invalid-'));
    saveTree(root, tree);
    const result = approvePlan(root);
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toMatch(/placeholder/i);
  });

  it('passes warnings through from validatePlan', () => {
    const tree = okTree();
    tree.root.children[0].review = ['unavailable-reviewer'];
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'warn-'));
    saveTree(root, tree);
    const result = approvePlan(root, { availableReviewers: new Set([]) });
    expect(result.ok).toBe(true);
    expect(result.warnings.join('\n')).toMatch(/unavailable-reviewer/);
  });
});
