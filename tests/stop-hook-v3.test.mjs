import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runStopHook } from '../engine/stop-hook.mjs';
import { saveState, saveTree } from '../engine/state.mjs';
import { activeDir } from '../engine/paths.mjs';

const tmpRoots = [];
afterEach(() => {
  for (const r of tmpRoots) try { fs.rmSync(r, { recursive: true, force: true }); } catch {}
  tmpRoots.length = 0;
});

function setup({ stopHookDriver = false } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'v3-stoph-')));
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
        acceptance_criteria: ['c0'],
        review: [], validate: null, work_front: null, status: 'pursuing',
        evidence: [], blocker_reason: null, review_attempts: 0, notes: [], children: [],
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
  if (stopHookDriver) {
    fs.writeFileSync(
      path.join(activeDir(root), 'config.json'),
      JSON.stringify({ schema_version: 1, stopHookDriver: true }),
    );
  }
  return root;
}

describe('Stop-hook v3 default (hint-only)', () => {
  it('returns null stdout on lifecycle=pursuing when stopHookDriver=false (default)', async () => {
    const root = setup();
    const tp = path.join(root, 't.jsonl');
    fs.writeFileSync(tp, '');
    const r = await runStopHook({
      stdin: { session_id: 's', transcript_path: tp, cwd: root },
      projectRoot: root,
    });
    expect(r.stdout).toBeNull();
  });

  it('still fires continuation when stopHookDriver=true (opt-in legacy)', async () => {
    const root = setup({ stopHookDriver: true });
    const tp = path.join(root, 't.jsonl');
    fs.writeFileSync(tp, '');
    const r = await runStopHook({
      stdin: { session_id: 's', transcript_path: tp, cwd: root },
      projectRoot: root,
    });
    expect(r.stdout).toBeTruthy();
    // Legacy v2 continuation: decision=block with rendered prompt as reason.
    expect(r.stdout.decision).toBe('block');
    expect(typeof r.stdout.reason).toBe('string');
    expect(r.stdout.reason.length).toBeGreaterThan(0);
  });

  it('non-pursuing lifecycle (paused) still falls through (config-irrelevant)', async () => {
    // Pause the goal first via state.json edit
    const root = setup();
    const stPath = path.join(activeDir(root), 'state.json');
    const st = JSON.parse(fs.readFileSync(stPath, 'utf8'));
    st.lifecycle = 'paused';
    fs.writeFileSync(stPath, JSON.stringify(st, null, 2));
    const tp = path.join(root, 't.jsonl');
    fs.writeFileSync(tp, '');
    const r = await runStopHook({
      stdin: { session_id: 's', transcript_path: tp, cwd: root },
      projectRoot: root,
    });
    // Paused returns null stdout regardless of stopHookDriver flag
    // (existing pre-v3 lifecycle gate already handled this).
    expect(r.stdout).toBeNull();
  });
});
