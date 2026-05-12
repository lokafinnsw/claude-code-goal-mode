/**
 * v3.0.3 — auto-promote cursor.status pending → pursuing on first v3 CLI
 * engagement (evidence-add or achieve).
 *
 * Closes a deadlock user-reported 2026-05-12 where a cursor stuck in
 * `status=pending` (from historical v2 advance paths or after
 * `/goal-mode:goal-resume`) made v3 CLI verbs un-callable.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { evidenceAdd } from '../engine/evidence-add.mjs';
import { achieveCursor } from '../engine/achieve.mjs';
import { saveState, saveTree, loadState, loadTree } from '../engine/state.mjs';
import { activeDir } from '../engine/paths.mjs';

const tmpRoots = [];
afterEach(() => {
  for (const r of tmpRoots) {
    try { fs.rmSync(r, { recursive: true, force: true }); } catch {}
  }
  tmpRoots.length = 0;
});

function setup({ cursorStatus = 'pending', cursorId = 't1', lifecycle = 'pursuing', evidence = [] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-autopromote-'));
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
          acceptance_criteria: ['c0', 'c1'], review: [], validate: null,
          work_front: null, status: cursorStatus, evidence,
          blocker_reason: null, review_attempts: 0, notes: [], children: [] },
        { id: 't2', type: 'task', title: 't2', goal: 'g2',
          acceptance_criteria: ['c0'], review: [], validate: null,
          work_front: null, status: 'pending', evidence: [],
          blocker_reason: null, review_attempts: 0, notes: [], children: [] },
      ],
    },
  });
  saveState(root, {
    schema_version: 2, goal_id: 'g', lifecycle, cursor: cursorId,
    budget: { iterations: { used: 1, max: 100 }, tokens: { used: 0, max: 0 },
      wallclock: { started_at: new Date().toISOString(), max_seconds: 86400 } },
    session_id: 's', started_at: new Date().toISOString(),
    paused_at: null, ended_at: null, ended_reason: null,
    history: [], consecutive_silent_turns: 0,
  });
  return root;
}

// Setup for the non-task promote-guard test: cursor is a sprint with
// status='pending' (which is unusual but valid in schema).
function setupNonTask() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-autopromote-nt-'));
  tmpRoots.push(root);
  fs.mkdirSync(activeDir(root), { recursive: true });
  saveTree(root, {
    schema_version: 2, goal_id: 'g', mission: 'm',
    created_at: '2026-05-12T00:00:00.000Z',
    approved_at: '2026-05-12T00:00:00.000Z',
    root: {
      id: 's', type: 'sprint', title: 'S', goal: 'g', acceptance_criteria: [],
      review: [], validate: null, work_front: null, status: 'pending',
      evidence: [], blocker_reason: null, review_attempts: 0, notes: [],
      children: [
        { id: 't1', type: 'task', title: 't1', goal: 'g1',
          acceptance_criteria: ['c0'], review: [], validate: null,
          work_front: null, status: 'pending', evidence: [],
          blocker_reason: null, review_attempts: 0, notes: [], children: [] },
      ],
    },
  });
  saveState(root, {
    schema_version: 2, goal_id: 'g', lifecycle: 'pursuing', cursor: 's',
    budget: { iterations: { used: 1, max: 100 }, tokens: { used: 0, max: 0 },
      wallclock: { started_at: new Date().toISOString(), max_seconds: 86400 } },
    session_id: 's', started_at: new Date().toISOString(),
    paused_at: null, ended_at: null, ended_reason: null,
    history: [], consecutive_silent_turns: 0,
  });
  return root;
}

describe('v3.0.3 — auto-promote cursor pending → pursuing on first v3 CLI engagement', () => {
  it('1. evidenceAdd on pending cursor (lifecycle=pursuing) → promotes + adds evidence + emits cursor-engaged', () => {
    const root = setup({ cursorStatus: 'pending' });
    const r = evidenceAdd(root, { criterion: 0, file: 'src/foo.ts', line: 1, note: 'x' });
    expect(r.ok).toBe(true);
    expect(r.evidence_count).toBe(1);

    const tree = loadTree(root);
    expect(tree.root.children[0].status).toBe('pursuing');
    expect(tree.root.children[0].evidence).toHaveLength(1);

    const state = loadState(root);
    const engaged = state.history.filter((h) => h.event === 'cursor-engaged');
    expect(engaged).toHaveLength(1);
    expect(engaged[0].node_id).toBe('t1');
    expect(engaged[0].payload.from).toBe('pending');
    expect(engaged[0].payload.to).toBe('pursuing');
    expect(engaged[0].payload.reason).toBe('v3-cli-evidence-add');
  });

  it('2. achieveCursor on pending cursor with pre-seeded evidence → promotes + proceeds to achieved + emits cursor-engaged', () => {
    const seededEvidence = [
      { ts: '2026-05-12T00:00:01.000Z', iteration: 1, criterion_index: 0, file: 'a', line: null, commit: null, command: null, exit_code: null, note: 'seed-0' },
      { ts: '2026-05-12T00:00:02.000Z', iteration: 1, criterion_index: 1, file: 'b', line: null, commit: null, command: null, exit_code: null, note: 'seed-1' },
    ];
    const root = setup({ cursorStatus: 'pending', evidence: seededEvidence });
    const r = achieveCursor(root);
    expect(r.ok).toBe(true);
    expect(r.status).toBe('achieved');
    expect(r.next_cursor).toBe('t2');

    const tree = loadTree(root);
    expect(tree.root.children[0].status).toBe('achieved');

    const state = loadState(root);
    const engaged = state.history.filter((h) => h.event === 'cursor-engaged');
    expect(engaged).toHaveLength(1);
    expect(engaged[0].payload.reason).toBe('v3-cli-achieve');
  });

  it('3. promote does NOT fire on non-task nodes (sprint cursor with status=pending → error, no promote)', () => {
    const root = setupNonTask();
    // evidenceAdd: cursor.type='sprint' will hit the status guard since
    // promote only triggers when type==='task'. Status is 'pending' so the
    // existing guard errors with "not pursuing or review-pending".
    const r = evidenceAdd(root, { criterion: 0, file: 'f', note: '' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/pursuing or review-pending/i);

    const tree = loadTree(root);
    expect(tree.root.status).toBe('pending');  // not promoted

    const state = loadState(root);
    const engaged = state.history.filter((h) => h.event === 'cursor-engaged');
    expect(engaged).toHaveLength(0);
  });

  it('4. promote does NOT fire when cursor.status is achieved or blocked (those error normally)', () => {
    // achieved
    const root1 = setup({ cursorStatus: 'achieved' });
    const r1 = evidenceAdd(root1, { criterion: 0, file: 'f', note: '' });
    expect(r1.ok).toBe(false);
    expect(r1.error).toMatch(/pursuing or review-pending/i);
    expect(r1.error).toMatch(/achieved/);
    const st1 = loadState(root1);
    expect(st1.history.filter((h) => h.event === 'cursor-engaged')).toHaveLength(0);

    // blocked
    const root2 = setup({ cursorStatus: 'blocked' });
    const r2 = evidenceAdd(root2, { criterion: 0, file: 'f', note: '' });
    expect(r2.ok).toBe(false);
    expect(r2.error).toMatch(/pursuing or review-pending/i);
    expect(r2.error).toMatch(/blocked/);
    const st2 = loadState(root2);
    expect(st2.history.filter((h) => h.event === 'cursor-engaged')).toHaveLength(0);
  });

  it('5. promote does NOT fire when lifecycle !== pursuing (lifecycle precondition still wins)', () => {
    const root = setup({ cursorStatus: 'pending', lifecycle: 'paused' });
    const r = evidenceAdd(root, { criterion: 0, file: 'f', note: '' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/lifecycle/);

    const tree = loadTree(root);
    expect(tree.root.children[0].status).toBe('pending');  // not promoted

    const state = loadState(root);
    expect(state.history.filter((h) => h.event === 'cursor-engaged')).toHaveLength(0);

    // same for achieve
    const r2 = achieveCursor(root);
    expect(r2.ok).toBe(false);
    expect(r2.error).toMatch(/lifecycle/);
  });

  it('6. promote is idempotent — second evidenceAdd does NOT emit a second cursor-engaged event', () => {
    const root = setup({ cursorStatus: 'pending' });
    const r1 = evidenceAdd(root, { criterion: 0, file: 'a', note: 'first' });
    expect(r1.ok).toBe(true);
    const r2 = evidenceAdd(root, { criterion: 1, file: 'b', note: 'second' });
    expect(r2.ok).toBe(true);

    const state = loadState(root);
    const engaged = state.history.filter((h) => h.event === 'cursor-engaged');
    expect(engaged).toHaveLength(1);  // only one, from the first call
  });

  it('7. full v3 flow regression — pending cursor → evidence-add (promotes) → evidence-add → achieve → next cursor', () => {
    const root = setup({ cursorStatus: 'pending' });
    const r1 = evidenceAdd(root, { criterion: 0, file: 'a', note: 'ac0' });
    expect(r1.ok).toBe(true);
    const r2 = evidenceAdd(root, { criterion: 1, file: 'b', note: 'ac1' });
    expect(r2.ok).toBe(true);
    const r3 = achieveCursor(root);
    expect(r3.ok).toBe(true);
    expect(r3.status).toBe('achieved');
    expect(r3.next_cursor).toBe('t2');

    const tree = loadTree(root);
    expect(tree.root.children[0].status).toBe('achieved');

    const state = loadState(root);
    const engaged = state.history.filter((h) => h.event === 'cursor-engaged');
    expect(engaged).toHaveLength(1);  // only one promote across the whole flow
    expect(engaged[0].payload.reason).toBe('v3-cli-evidence-add');
  });
});
