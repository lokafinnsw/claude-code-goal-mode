import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { achieveCursor } from '../engine/achieve.mjs';
import { evidenceAdd } from '../engine/evidence-add.mjs';
import { saveState, saveTree, loadState, loadTree } from '../engine/state.mjs';
import { activeDir } from '../engine/paths.mjs';

const tmpRoots = [];
afterEach(() => {
  for (const r of tmpRoots) {
    try { fs.rmSync(r, { recursive: true, force: true }); } catch {}
  }
  tmpRoots.length = 0;
});

function setup({ review = [] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-ach-'));
  tmpRoots.push(root);
  fs.mkdirSync(activeDir(root), { recursive: true });
  saveTree(root, {
    schema_version: 2, goal_id: 'g', mission: 'm',
    created_at: '2026-05-12T00:00:00.000Z',
    approved_at: '2026-05-12T00:00:00.000Z',
    root: {
      id: 's', type: 'sprint', title: 'S', goal: 'g', acceptance_criteria: [],
      review: [], validate: null, work_front: null, status: 'pursuing',
      evidence: [], blocker_reason: null, review_attempts: 0, notes: [],
      children: [
        { id: 't1', type: 'task', title: 't1', goal: 'g1',
          acceptance_criteria: ['c0', 'c1'], review, validate: null,
          work_front: null, status: 'pursuing', evidence: [],
          blocker_reason: null, review_attempts: 0, notes: [], children: [] },
        { id: 't2', type: 'task', title: 't2', goal: 'g2',
          acceptance_criteria: ['c0'], review: [], validate: null,
          work_front: null, status: 'pending', evidence: [],
          blocker_reason: null, review_attempts: 0, notes: [], children: [] },
      ],
    },
  });
  saveState(root, {
    schema_version: 2, goal_id: 'g', lifecycle: 'pursuing', cursor: 't1',
    budget: { iterations: { used: 1, max: 100 }, tokens: { used: 0, max: 0 },
      wallclock: { started_at: new Date().toISOString(), max_seconds: 86400 } },
    session_id: 's', started_at: new Date().toISOString(),
    paused_at: null, ended_at: null, ended_reason: null,
    history: [], consecutive_silent_turns: 0,
  });
  return root;
}

describe('achieveCursor', () => {
  it('rejects when not all ACs covered (lists missing)', () => {
    const root = setup();
    evidenceAdd(root, { criterion: 0, file: 'a', note: '' });
    const r = achieveCursor(root);
    expect(r.ok).toBe(false);
    expect(r.missing_criteria).toEqual([1]);
  });

  it('rejects when no ACs covered at all', () => {
    const root = setup();
    const r = achieveCursor(root);
    expect(r.ok).toBe(false);
    expect(r.missing_criteria).toEqual([0, 1]);
  });

  it('with empty review[]: marks achieved + advances cursor', () => {
    const root = setup({ review: [] });
    evidenceAdd(root, { criterion: 0, file: 'a', note: '' });
    evidenceAdd(root, { criterion: 1, file: 'b', note: '' });
    const r = achieveCursor(root);
    expect(r.ok).toBe(true);
    expect(r.status).toBe('achieved');
    expect(r.next_cursor).toBe('t2');
    const tree = loadTree(root);
    expect(tree.root.children[0].status).toBe('achieved');
  });

  it('with non-empty review[]: transitions to review-pending', () => {
    const root = setup({ review: ['aaa-art-director'] });
    evidenceAdd(root, { criterion: 0, file: 'a', note: '' });
    evidenceAdd(root, { criterion: 1, file: 'b', note: '' });
    const r = achieveCursor(root);
    expect(r.ok).toBe(true);
    expect(r.status).toBe('review-pending');
    expect(r.required_reviewers).toEqual(['aaa-art-director']);
    const tree = loadTree(root);
    expect(tree.root.children[0].status).toBe('review-pending');
  });

  it('rejects when lifecycle != pursuing', () => {
    const root = setup();
    const st = loadState(root);
    st.lifecycle = 'paused';
    saveState(root, st);
    const r = achieveCursor(root);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/lifecycle/);
  });

  it('rejects when no active goal', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-ach-nogoal-'));
    tmpRoots.push(root);
    const r = achieveCursor(root);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/No active goal/);
  });
});
