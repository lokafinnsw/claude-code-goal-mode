import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { currentTask, formatHuman, formatAsBuiltin } from '../engine/current.mjs';
import { saveState, saveTree } from '../engine/state.mjs';
import { activeDir } from '../engine/paths.mjs';
import { evidenceAdd } from '../engine/evidence-add.mjs';

const CLI = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', 'engine', 'current-cli.mjs',
);

const tmpRoots = [];
afterEach(() => {
  for (const r of tmpRoots) try { fs.rmSync(r, { recursive: true, force: true }); } catch {}
  tmpRoots.length = 0;
});

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-cur-'));
  tmpRoots.push(root);
  fs.mkdirSync(activeDir(root), { recursive: true });
  saveTree(root, {
    schema_version: 2, goal_id: 'g', mission: 'm',
    created_at: '2026-05-12T00:00:00.000Z',
    approved_at: '2026-05-12T00:00:00.000Z',
    root: {
      id: 's', type: 'sprint', title: 'S', goal: 'sprint goal',
      acceptance_criteria: [], review: [], validate: null,
      work_front: null, status: 'pursuing', evidence: [],
      blocker_reason: null, review_attempts: 0, notes: [],
      children: [{
        id: 't', type: 'task', title: 'My Task', goal: 'do the thing',
        acceptance_criteria: ['ac zero', 'ac one'],
        review: ['aaa-art-director'], validate: 'npm test',
        work_front: 'F1', status: 'pursuing', evidence: [],
        blocker_reason: null, review_attempts: 0, notes: [], children: [],
      }],
    },
  });
  saveState(root, {
    schema_version: 2, goal_id: 'g', lifecycle: 'pursuing', cursor: 't',
    budget: { iterations: { used: 1, max: 100 }, tokens: { used: 0, max: 0 },
      wallclock: { started_at: new Date().toISOString(), max_seconds: 86400 } },
    session_id: 's', started_at: new Date().toISOString(),
    paused_at: null, ended_at: null, ended_reason: null,
    history: [], consecutive_silent_turns: 0,
  });
  return root;
}

describe('currentTask (core)', () => {
  it('returns cursor snapshot with empty evidence + full missing list', () => {
    const root = setup();
    const r = currentTask(root);
    expect(r.ok).toBe(true);
    expect(r.lifecycle).toBe('pursuing');
    expect(r.cursor).toBe('t');
    expect(r.task.title).toBe('My Task');
    expect(r.task.acceptance_criteria).toEqual(['ac zero', 'ac one']);
    expect(r.task.review).toEqual(['aaa-art-director']);
    expect(r.task.validate).toBe('npm test');
    expect(r.evidence_count).toBe(0);
    expect(r.missing_criteria).toEqual([0, 1]);
  });

  it('reflects partial evidence coverage in missing_criteria', () => {
    const root = setup();
    evidenceAdd(root, { criterion: 0, file: 'a' });
    const r = currentTask(root);
    expect(r.evidence_count).toBe(1);
    expect(r.missing_criteria).toEqual([1]);
  });

  it('rejects when no active goal', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-cur-nogoal-'));
    tmpRoots.push(root);
    const r = currentTask(root);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/No active goal/);
  });
});

describe('formatHuman', () => {
  it('renders multiline summary with checkboxes', () => {
    const r = currentTask(setup());
    const s = formatHuman(r);
    expect(s).toMatch(/Task: My Task \(t\)/);
    expect(s).toMatch(/Status: pursuing/);
    expect(s).toMatch(/\[ \] #0 — ac zero/);
    expect(s).toMatch(/\[ \] #1 — ac one/);
    expect(s).toMatch(/Reviewers required: aaa-art-director/);
    expect(s).toMatch(/Validate: npm test/);
    expect(s).toMatch(/Work front: F1/);
    expect(s).toMatch(/Evidence collected: 0/);
  });

  it('marks covered criteria with [x]', () => {
    const root = setup();
    evidenceAdd(root, { criterion: 0, file: 'a' });
    const s = formatHuman(currentTask(root));
    expect(s).toMatch(/\[x\] #0/);
    expect(s).toMatch(/\[ \] #1/);
  });

  it('returns error prefix on !ok', () => {
    const s = formatHuman({ ok: false, error: 'boom' });
    expect(s).toBe('❌ boom');
  });
});

describe('formatAsBuiltin', () => {
  it('emits single-line text with goal + acceptance criteria + workflow hint', () => {
    const s = formatAsBuiltin(currentTask(setup()));
    expect(s).toMatch(/^Goal: do the thing\./);
    expect(s).toMatch(/Acceptance: \(#0\) ac zero; \(#1\) ac one\./);
    expect(s).toMatch(/Run \/goal-mode:evidence-add per criterion, then \/goal-mode:achieve\./);
    // Single line — no \n
    expect(s.includes('\n')).toBe(false);
  });

  it('returns empty string on !ok', () => {
    expect(formatAsBuiltin({ ok: false, error: 'x' })).toBe('');
  });
});

describe('current-cli (CLI smoke)', () => {
  it('exits 0 with human-readable output (default)', () => {
    const root = setup();
    const r = spawnSync('node', [CLI], { cwd: root });
    expect(r.status).toBe(0);
    expect(r.stdout.toString()).toMatch(/Task: My Task/);
  });

  it('exits 0 with --json (parseable)', () => {
    const root = setup();
    const r = spawnSync('node', [CLI, '--json'], { cwd: root });
    expect(r.status).toBe(0);
    const obj = JSON.parse(r.stdout.toString());
    expect(obj.cursor).toBe('t');
    expect(obj.missing_criteria).toEqual([0, 1]);
  });

  it('exits 0 with --as-builtin (single-line)', () => {
    const root = setup();
    const r = spawnSync('node', [CLI, '--as-builtin'], { cwd: root });
    expect(r.status).toBe(0);
    const out = r.stdout.toString().trim();
    expect(out.startsWith('Goal:')).toBe(true);
    expect(out.includes('\n')).toBe(false);
  });

  it('exits 2 on unknown flag', () => {
    const root = setup();
    const r = spawnSync('node', [CLI, '--bogus'], { cwd: root });
    expect(r.status).toBe(2);
  });

  it('exits 2 on --json + --as-builtin combined', () => {
    const root = setup();
    const r = spawnSync('node', [CLI, '--json', '--as-builtin'], { cwd: root });
    expect(r.status).toBe(2);
  });

  it('exits 1 on no active goal', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-cur-nogoal-'));
    tmpRoots.push(root);
    const r = spawnSync('node', [CLI], { cwd: root });
    expect(r.status).toBe(1);
    expect(r.stderr.toString()).toMatch(/No active goal/);
  });
});
