import { describe, it, expect } from 'vitest';
import { manualApprove } from '../engine/manual-approve.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { saveTree, saveState, loadState, loadTree } from '../engine/state.mjs';

const sampleTree = (review = ['art-x']) => ({
  schema_version: 2,
  goal_id: 'g',
  mission: 'm',
  created_at: '2026-05-09T00:00:00.000Z',
  approved_at: '2026-05-09T00:00:00.000Z',
  root: {
    id: 's', type: 'sprint', title: 's', goal: 'g',
    acceptance_criteria: [], review: [], validate: null,
    work_front: 'engine', status: 'pursuing',
    evidence: [], blocker_reason: null, review_attempts: 0, notes: [],
    children: [
      {
        id: 's.t1', type: 'task', title: 't1', goal: 'g',
        acceptance_criteria: ['c0'], review,
        validate: null, work_front: 'engine', status: 'review-pending',
        evidence: [
          { ts: '2026-05-09T00:00:00.000Z', iteration: 1, criterion_index: 0, file: 'x', line: null, commit: null, command: null, exit_code: null, note: 'n' },
        ],
        blocker_reason: null, review_attempts: 0, notes: [], children: [],
      },
      {
        id: 's.t2', type: 'task', title: 't2', goal: 'g',
        acceptance_criteria: ['c0'], review: [],
        validate: null, work_front: 'engine', status: 'pending',
        evidence: [], blocker_reason: null, review_attempts: 0, notes: [],
        children: [],
      },
    ],
  },
});

const sampleState = (cursor = 's.t1') => ({
  schema_version: 2,
  goal_id: 'g',
  lifecycle: 'pursuing',
  cursor,
  budget: {
    iterations: { used: 5, max: 100 },
    tokens: { used: 0, max: 1_000_000 },
    wallclock: { started_at: new Date().toISOString(), max_seconds: 14400 },
  },
  session_id: 'sess-1',
  started_at: new Date().toISOString(),
  paused_at: null, ended_at: null, ended_reason: null,
  history: [],
});

function setup(tree, state) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-approve-'));
  if (tree) saveTree(root, tree);
  if (state) saveState(root, state);
  return root;
}

describe('manualApprove', () => {
  it('marks review-pending node achieved + advances cursor + writes audit file', () => {
    const root = setup(sampleTree(), sampleState());
    const result = manualApprove(root, { reason: 'looks good' });
    expect(result.ok).toBe(true);
    expect(result.cursor).toBe('s.t2');

    const tree = loadTree(root);
    expect(tree.root.children[0].status).toBe('achieved');

    const state = loadState(root);
    expect(state.cursor).toBe('s.t2');
    const lastEvents = state.history.slice(-2).map(h => h.event);
    expect(lastEvents).toEqual(['review-verdict', 'cursor-advanced']);

    // Audit file written.
    const auditFiles = fs.readdirSync(path.join(root, '.claude/goals/active/audits'));
    expect(auditFiles.length).toBe(1);
    const body = JSON.parse(fs.readFileSync(path.join(root, '.claude/goals/active/audits', auditFiles[0]), 'utf8'));
    expect(body).toMatchObject({
      agent: 'manual',
      status: 'GO',
      manual: true,
      text: 'looks good',
    });
  });

  it('uses default reason when none provided', () => {
    const root = setup(sampleTree(), sampleState());
    const result = manualApprove(root, {});
    expect(result.ok).toBe(true);

    const auditFiles = fs.readdirSync(path.join(root, '.claude/goals/active/audits'));
    const body = JSON.parse(fs.readFileSync(path.join(root, '.claude/goals/active/audits', auditFiles[0]), 'utf8'));
    expect(body.text).toBe('manual approve');
  });

  it('transitions lifecycle to achieved when last task is approved', () => {
    const tree = sampleTree();
    tree.root.children[1].status = 'achieved';  // t2 already done
    const state = sampleState('s.t1');
    const root = setup(tree, state);
    const result = manualApprove(root, {});
    expect(result.ok).toBe(true);

    const newState = loadState(root);
    expect(newState.lifecycle).toBe('achieved');
    expect(newState.ended_reason).toMatch(/manual approve/i);
  });

  it('refuses if no active goal (state missing)', () => {
    const root = setup(null, null);
    const result = manualApprove(root, {});
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/no active goal/i);
  });

  it('refuses if no tree (state present but tree missing)', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-approve-no-tree-'));
    saveState(root, sampleState());
    const result = manualApprove(root, {});
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/no.*tree/i);
  });

  it('refuses if cursor node not found in tree', () => {
    const tree = sampleTree();
    const state = sampleState('nonexistent-id');
    const root = setup(tree, state);
    const result = manualApprove(root, {});
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/cursor.*not found/i);
  });

  it('refuses if cursor node is not review-pending', () => {
    const tree = sampleTree();
    tree.root.children[0].status = 'pursuing';  // not review-pending
    const state = sampleState('s.t1');
    const root = setup(tree, state);
    const result = manualApprove(root, {});
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not.*review-pending/i);
  });

  it('refuses if state.lifecycle is not pursuing', () => {
    const tree = sampleTree();
    const state = sampleState('s.t1');
    state.lifecycle = 'paused';
    const root = setup(tree, state);
    const result = manualApprove(root, {});
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/lifecycle=paused/);
  });

  it('records iteration counter in the manual review-verdict event', () => {
    const tree = sampleTree();
    const state = sampleState('s.t1');
    state.budget.iterations.used = 7;
    const root = setup(tree, state);
    manualApprove(root, { reason: 'fine' });
    const newState = loadState(root);
    const verdictEvent = newState.history.find(h => h.event === 'review-verdict');
    expect(verdictEvent.iteration).toBe(7);
  });

  it('sanitizes node_id in manual approve audit filename', () => {
    const tree = sampleTree();
    tree.root.children[0].id = 's/t1';  // path-illegal char
    tree.root.children[1].id = 's/t2';
    const state = sampleState('s/t1');
    const root = setup(tree, state);

    const result = manualApprove(root, { reason: 'ok' });
    expect(result.ok).toBe(true);

    const auditFiles = fs.readdirSync(path.join(root, '.claude/goals/active/audits'));
    expect(auditFiles.length).toBe(1);
    expect(auditFiles[0]).not.toContain('/');
    expect(auditFiles[0]).toMatch(/^s_t1-/);
    expect(auditFiles[0]).toContain('manual');

    const body = JSON.parse(fs.readFileSync(path.join(root, '.claude/goals/active/audits', auditFiles[0]), 'utf8'));
    expect(body.node_id).toBe('s/t1');
  });

  it('Bug B: collapses .. sequences in node_id to prevent traversal escape', () => {
    const tree = sampleTree();
    tree.root.children[0].id = '../escape-attempt';
    tree.root.children[1].id = 's.t2';
    const state = sampleState('../escape-attempt');
    const root = setup(tree, state);

    const result = manualApprove(root, { reason: 'ok' });
    expect(result.ok).toBe(true);

    const auditFiles = fs.readdirSync(path.join(root, '.claude/goals/active/audits'));
    expect(auditFiles.length).toBe(1);
    // Filename must contain neither '..' nor '/'.
    expect(auditFiles[0]).not.toContain('..');
    expect(auditFiles[0]).not.toContain('/');
    // Body keeps original unsanitized value (sanitization is filename-only).
    const body = JSON.parse(fs.readFileSync(path.join(root, '.claude/goals/active/audits', auditFiles[0]), 'utf8'));
    expect(body.node_id).toBe('../escape-attempt');
  });
});
