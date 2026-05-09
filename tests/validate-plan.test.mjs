import { describe, it, expect } from 'vitest';
import { validatePlan } from '../engine/validate-plan.mjs';

const okTree = () => ({
  schema_version: 1,
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

  it('rejects empty acceptance_criteria for a task', () => {
    const t = okTree();
    t.root.children[0].acceptance_criteria = [];
    const r = validatePlan(t);
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toMatch(/acceptance_criteria/i);
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
