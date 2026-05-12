import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { saveState, saveTree } from '../engine/state.mjs';
import { activeDir } from '../engine/paths.mjs';

const CLI = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', 'engine', 'evidence-add-cli.mjs',
);

const tmpRoots = [];
afterEach(() => {
  for (const r of tmpRoots) {
    try { fs.rmSync(r, { recursive: true, force: true }); } catch {}
  }
  tmpRoots.length = 0;
});

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-evcli-'));
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
      children: [{
        id: 't', type: 'task', title: 't', goal: 'tg',
        acceptance_criteria: ['c0', 'c1'],
        review: [], validate: null, work_front: null, status: 'pursuing',
        evidence: [], blocker_reason: null, review_attempts: 0, notes: [], children: [],
      }],
    },
  });
  saveState(root, {
    schema_version: 2, goal_id: 'g', lifecycle: 'pursuing', cursor: 't',
    budget: {
      iterations: { used: 1, max: 100 },
      tokens: { used: 0, max: 0 },
      wallclock: { started_at: new Date().toISOString(), max_seconds: 86400 },
    },
    session_id: 's', started_at: new Date().toISOString(),
    paused_at: null, ended_at: null, ended_reason: null,
    history: [], consecutive_silent_turns: 0,
  });
  return root;
}

describe('evidence-add-cli', () => {
  it('exits 0 with file-based evidence', () => {
    const root = setup();
    const r = spawnSync('node', [CLI, '--criterion', '0', '--file', 'src/foo.ts:42', '--note', 'proof'], { cwd: root });
    expect(r.status).toBe(0);
    expect(r.stdout.toString()).toMatch(/evidence #1 added/);
  });

  it('exits 0 with shell-based evidence', () => {
    const root = setup();
    const r = spawnSync('node', [CLI, '--criterion', '1', '--command', 'npm test', '--exit-code', '0', '--note', 'green'], { cwd: root });
    expect(r.status).toBe(0);
    expect(r.stdout.toString()).toMatch(/evidence #1 added/);
  });

  it('exits 2 on missing --criterion', () => {
    const root = setup();
    const r = spawnSync('node', [CLI, '--file', 'src/foo.ts'], { cwd: root });
    expect(r.status).toBe(2);
    expect(r.stderr.toString()).toMatch(/criterion/);
  });

  it('exits 2 when neither --file nor --command supplied', () => {
    const root = setup();
    const r = spawnSync('node', [CLI, '--criterion', '0'], { cwd: root });
    expect(r.status).toBe(2);
    expect(r.stderr.toString()).toMatch(/file or --command/);
  });

  it('exits 2 on unknown argument', () => {
    const root = setup();
    const r = spawnSync('node', [CLI, '--bogus', 'x'], { cwd: root });
    expect(r.status).toBe(2);
    expect(r.stderr.toString()).toMatch(/Unknown arg/);
  });

  it('exits 1 on lifecycle != pursuing (precondition failure)', () => {
    const root = setup();
    // Force paused state.
    const st = JSON.parse(fs.readFileSync(path.join(activeDir(root), 'state.json'), 'utf8'));
    st.lifecycle = 'paused';
    fs.writeFileSync(path.join(activeDir(root), 'state.json'), JSON.stringify(st));
    const r = spawnSync('node', [CLI, '--criterion', '0', '--file', 'f', '--note', ''], { cwd: root });
    expect(r.status).toBe(1);
    expect(r.stderr.toString()).toMatch(/lifecycle/);
  });
});
