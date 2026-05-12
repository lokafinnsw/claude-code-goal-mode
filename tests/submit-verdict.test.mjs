import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { submitVerdict } from '../engine/submit-verdict.mjs';
import { saveState, saveTree, loadState } from '../engine/state.mjs';
import { activeDir } from '../engine/paths.mjs';

const tmpRoots = [];
afterEach(() => {
  for (const r of tmpRoots) {
    try { fs.rmSync(r, { recursive: true, force: true }); } catch {}
  }
  tmpRoots.length = 0;
});

function setup({ status = 'review-pending', review = ['aaa-art-director'] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-verd-'));
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
          acceptance_criteria: ['c0'], review, validate: null,
          work_front: null, status, evidence: [
            { ts: '2026-05-12T00:00:00.000Z', iteration: 1, criterion_index: 0,
              file: 'f', line: null, commit: null, command: null,
              exit_code: null, note: '' },
          ],
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

describe('submitVerdict', () => {
  it('GO verdict from a dispatched reviewer advances cursor', () => {
    const root = setup();
    const r = submitVerdict(root, {
      agent: 'aaa-art-director', status: 'GO', text: 'looks good',
      scannedAgents: new Set(['aaa-art-director']),
    });
    expect(r.ok).toBe(true);
    expect(r.status).toBe('achieved');
    expect(r.next_cursor).toBe('t2');
  });

  it('GO verdict from un-dispatched reviewer is REJECTED', () => {
    const root = setup();
    const r = submitVerdict(root, {
      agent: 'aaa-art-director', status: 'GO', text: 'looks good',
      scannedAgents: new Set(),
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/independence/);
  });

  it('NOGO verdict from a dispatched reviewer keeps cursor and increments attempts', () => {
    const root = setup();
    const r = submitVerdict(root, {
      agent: 'aaa-art-director', status: 'NOGO', text: 'AC#0 not met',
      scannedAgents: new Set(['aaa-art-director']),
    });
    expect(r.ok).toBe(true);
    // NOGO sends cursor back to pursuing (review_attempts < 3 threshold)
    expect(r.status).toBe('pursuing');
  });

  it('escape-hatch REVISE (unavailable; ...) transitions to awaiting-manual-approval', () => {
    const root = setup();
    const r = submitVerdict(root, {
      agent: 'aaa-art-director', status: 'REVISE',
      text: 'unavailable; user must run /goal-approve',
      scannedAgents: new Set(),
    });
    const st = loadState(root);
    expect(r.ok).toBe(true);
    expect(st.lifecycle).toBe('awaiting-manual-approval');
    expect(r.status).toBe('blocked');
  });

  it('rejects missing agent', () => {
    const root = setup();
    const r = submitVerdict(root, { status: 'GO', scannedAgents: new Set() });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/agent/);
  });

  it('rejects invalid status', () => {
    const root = setup();
    const r = submitVerdict(root, {
      agent: 'a', status: 'MAYBE', scannedAgents: new Set(['a']),
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/invalid status/);
  });

  it('rejects missing scannedAgents', () => {
    const root = setup();
    const r = submitVerdict(root, { agent: 'a', status: 'GO' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/scannedAgents/);
  });

  it('rejects when cursor not review-pending', () => {
    const root = setup({ status: 'pursuing' });
    const r = submitVerdict(root, {
      agent: 'aaa-art-director', status: 'GO',
      scannedAgents: new Set(['aaa-art-director']),
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/review-pending/);
  });

  it('rejects when lifecycle != pursuing', () => {
    const root = setup();
    const st = loadState(root);
    st.lifecycle = 'paused';
    saveState(root, st);
    const r = submitVerdict(root, {
      agent: 'aaa-art-director', status: 'GO',
      scannedAgents: new Set(['aaa-art-director']),
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/lifecycle/);
  });
});
