import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { saveState, saveTree, loadState } from '../engine/state.mjs';
import { activeDir } from '../engine/paths.mjs';
import { evidenceAdd } from '../engine/evidence-add.mjs';

const CLI = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', 'engine', 'achieve-cli.mjs',
);

const tmpRoots = [];
afterEach(() => {
  for (const r of tmpRoots) {
    try { fs.rmSync(r, { recursive: true, force: true }); } catch {}
  }
  tmpRoots.length = 0;
});

function setup({ review = [] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-achcli-'));
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

describe('achieve-cli', () => {
  it('exits 1 with missing-criteria list on stderr', () => {
    const root = setup();
    const r = spawnSync('node', [CLI], { cwd: root });
    expect(r.status).toBe(1);
    expect(r.stderr.toString()).toMatch(/missing evidence for criteria/);
  });

  it('exits 0 with achieved message on stdout (empty review)', () => {
    const root = setup();
    evidenceAdd(root, { criterion: 0, file: 'a' });
    evidenceAdd(root, { criterion: 1, file: 'b' });
    const r = spawnSync('node', [CLI], { cwd: root });
    expect(r.status).toBe(0);
    expect(r.stdout.toString()).toMatch(/achieved → next cursor: t2/);
  });

  it('exits 0 with review-pending message on stdout (non-empty review)', () => {
    const root = setup({ review: ['aaa-art-director'] });
    evidenceAdd(root, { criterion: 0, file: 'a' });
    evidenceAdd(root, { criterion: 1, file: 'b' });
    const r = spawnSync('node', [CLI], { cwd: root });
    expect(r.status).toBe(0);
    expect(r.stdout.toString()).toMatch(/review-pending → reviewers required: aaa-art-director/);
  });

  it('exits 1 on lifecycle != pursuing', () => {
    const root = setup();
    const st = loadState(root);
    st.lifecycle = 'paused';
    saveState(root, st);
    const r = spawnSync('node', [CLI], { cwd: root });
    expect(r.status).toBe(1);
    expect(r.stderr.toString()).toMatch(/lifecycle/);
  });

  it('exits 2 on any argument', () => {
    const root = setup();
    const r = spawnSync('node', [CLI, '--bogus'], { cwd: root });
    expect(r.status).toBe(2);
    expect(r.stderr.toString()).toMatch(/Unknown argument/);
  });
});
