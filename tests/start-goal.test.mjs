import { describe, it, expect } from 'vitest';
import { startGoal } from '../engine/start-goal.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { saveTree } from '../engine/state.mjs';

const approvedTree = () => ({
  schema_version: 1,
  goal_id: 'g',
  mission: 'm',
  created_at: '2026-05-09T00:00:00.000Z',
  approved_at: '2026-05-09T00:00:00.000Z',
  root: {
    id: 's', type: 'sprint', title: 's', goal: 'g',
    acceptance_criteria: [], review: [], validate: null,
    work_front: null, status: 'pending',
    evidence: [], blocker_reason: null, review_attempts: 0, notes: [],
    children: [
      {
        id: 's.t1', type: 'task', title: 't1', goal: 'g',
        acceptance_criteria: ['c0'], review: [], validate: null,
        work_front: null, status: 'pending',
        evidence: [], blocker_reason: null, review_attempts: 0, notes: [],
        children: [],
      },
    ],
  },
});

describe('startGoal', () => {
  it('initializes state with cursor=first pending task and lifecycle=pursuing', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-'));
    saveTree(root, approvedTree());
    const result = startGoal(root, { sessionId: 'sess', maxIter: 50, tokenBudget: 1_000_000, timeBudgetSeconds: 7200 });
    expect(result.ok).toBe(true);
    const state = JSON.parse(fs.readFileSync(path.join(root, '.claude/goals/active/state.json'), 'utf8'));
    expect(state.lifecycle).toBe('pursuing');
    expect(state.cursor).toBe('s.t1');
    expect(state.session_id).toBe('sess');
    expect(state.budget.iterations.max).toBe(50);
  });

  it('refuses if no tree.json exists', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-'));
    const result = startGoal(root, { sessionId: 's', maxIter: 1, tokenBudget: 1, timeBudgetSeconds: 1 });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/no .* tree/i);
  });

  it('refuses if tree is not approved (approved_at is null)', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-'));
    const tree = approvedTree();
    tree.approved_at = null;
    saveTree(root, tree);
    const result = startGoal(root, { sessionId: 's', maxIter: 1, tokenBudget: 1, timeBudgetSeconds: 1 });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not approved/i);
  });

  it('refuses if no pending tasks remain in tree', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-'));
    const tree = approvedTree();
    tree.root.children[0].status = 'achieved';
    saveTree(root, tree);
    const result = startGoal(root, { sessionId: 's', maxIter: 1, tokenBudget: 1, timeBudgetSeconds: 1 });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/no pending(?: or pursuing)? tasks/i);
  });

  it('writes a started history event', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-'));
    saveTree(root, approvedTree());
    startGoal(root, { sessionId: 'sess', maxIter: 50, tokenBudget: 1_000_000, timeBudgetSeconds: 7200 });
    const state = JSON.parse(fs.readFileSync(path.join(root, '.claude/goals/active/state.json'), 'utf8'));
    expect(state.history.length).toBe(1);
    expect(state.history[0].event).toBe('started');
    expect(state.history[0].node_id).toBe('s.t1');
    expect(state.history[0].iteration).toBe(0);
  });
});

describe('startGoal hardening fix-ups', () => {
  it('records iteration=0 in the started history event (M-1)', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-'));
    saveTree(root, approvedTree());
    startGoal(root, { sessionId: 'sess', maxIter: 50, tokenBudget: 1_000_000, timeBudgetSeconds: 7200 });
    const state = JSON.parse(fs.readFileSync(path.join(root, '.claude/goals/active/state.json'), 'utf8'));
    expect(state.history[0].iteration).toBe(0);
  });

  it('refuses to overwrite an active goal without force (M-2)', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-'));
    saveTree(root, approvedTree());
    const first = startGoal(root, { sessionId: 'sess1', maxIter: 50, tokenBudget: 1_000_000, timeBudgetSeconds: 7200 });
    expect(first.ok).toBe(true);

    const second = startGoal(root, { sessionId: 'sess2', maxIter: 100, tokenBudget: 2_000_000, timeBudgetSeconds: 14400 });
    expect(second.ok).toBe(false);
    expect(second.error).toMatch(/already active/i);

    // First-call session_id preserved.
    const state = JSON.parse(fs.readFileSync(path.join(root, '.claude/goals/active/state.json'), 'utf8'));
    expect(state.session_id).toBe('sess1');
    expect(state.budget.iterations.max).toBe(50);
  });

  it('overwrites prior state when force=true (M-2)', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-'));
    saveTree(root, approvedTree());
    startGoal(root, { sessionId: 'sess1', maxIter: 50, tokenBudget: 1_000_000, timeBudgetSeconds: 7200 });

    const second = startGoal(root, { sessionId: 'sess2', maxIter: 100, tokenBudget: 2_000_000, timeBudgetSeconds: 14400, force: true });
    expect(second.ok).toBe(true);

    const state = JSON.parse(fs.readFileSync(path.join(root, '.claude/goals/active/state.json'), 'utf8'));
    expect(state.session_id).toBe('sess2');
    expect(state.budget.iterations.max).toBe(100);
  });

  it('accepts a tree with first leaf already pursuing as the cursor target (M-3)', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-'));
    const tree = approvedTree();
    tree.root.children[0].status = 'pursuing';
    saveTree(root, tree);
    const result = startGoal(root, { sessionId: 'sess', maxIter: 50, tokenBudget: 1_000_000, timeBudgetSeconds: 7200 });
    expect(result.ok).toBe(true);
    expect(result.cursor).toBe('s.t1');
  });

  it('refuses if all leaves are achieved/blocked/skipped with no pending or pursuing (M-3)', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-'));
    const tree = approvedTree();
    tree.root.children[0].status = 'achieved';
    saveTree(root, tree);
    const result = startGoal(root, { sessionId: 'sess', maxIter: 50, tokenBudget: 1_000_000, timeBudgetSeconds: 7200 });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/no pending or pursuing/i);
  });
});
