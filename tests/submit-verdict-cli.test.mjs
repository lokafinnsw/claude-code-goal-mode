import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { saveState, saveTree, loadState } from '../engine/state.mjs';
import { activeDir } from '../engine/paths.mjs';

const CLI = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', 'engine', 'submit-verdict-cli.mjs',
);

const tmpRoots = [];
const tmpHomes = [];
afterEach(() => {
  for (const r of tmpRoots) try { fs.rmSync(r, { recursive: true, force: true }); } catch {}
  for (const h of tmpHomes) try { fs.rmSync(h, { recursive: true, force: true }); } catch {}
  tmpRoots.length = 0;
  tmpHomes.length = 0;
});

function setup({ review = ['aaa-art-director'] } = {}) {
  // realpathSync: on macOS, /var → /private/var, and spawned node's
  // process.cwd() returns the canonical form. The transcript-dir
  // encoding must match what the child process sees, not what mkdtempSync
  // returned, or scanAgentInvocations() will look at the wrong dir.
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'v3-svcli-')));
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
          work_front: null, status: 'review-pending', evidence: [
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

// Construct a fake HOME with a synthetic transcript containing an Agent(subagent_type='X') call.
function fakeHomeWithTranscript(cwd, agentTypes) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-svhome-'));
  tmpHomes.push(home);
  const encoded = '-' + cwd.replace(/^\//, '').replace(/\//g, '-');
  const dir = path.join(home, '.claude', 'projects', encoded);
  fs.mkdirSync(dir, { recursive: true });
  // session uuid is the basename of the most-recent .jsonl
  const sid = 'test-session-uuid';
  const tp = path.join(dir, `${sid}.jsonl`);
  // Format: each Agent() invocation appears as a message with
  // content[].type='tool_use' and content[].name='Agent' with
  // input.subagent_type='<type>'. See engine/transcript.mjs scanAgentInvocations
  // for the exact shape consumed (matches 'Agent' or 'agent').
  const lines = agentTypes.map(t => JSON.stringify({
    timestamp: '2026-05-12T00:00:00.000Z',
    message: {
      role: 'assistant',
      content: [
        { type: 'tool_use', name: 'Agent', input: { subagent_type: t, description: 'r', prompt: 'p' } },
      ],
    },
  }));
  fs.writeFileSync(tp, lines.join('\n') + '\n');
  return home;
}

describe('submit-verdict-cli', () => {
  it('exits 2 on missing --agent', () => {
    const root = setup();
    const r = spawnSync('node', [CLI, '--status', 'GO'], { cwd: root });
    expect(r.status).toBe(2);
    expect(r.stderr.toString()).toMatch(/agent/);
  });

  it('exits 2 on missing --status', () => {
    const root = setup();
    const r = spawnSync('node', [CLI, '--agent', 'aaa-art-director'], { cwd: root });
    expect(r.status).toBe(2);
    expect(r.stderr.toString()).toMatch(/status/);
  });

  it('exits 2 on unknown arg', () => {
    const root = setup();
    const r = spawnSync('node', [CLI, '--bogus', 'x'], { cwd: root });
    expect(r.status).toBe(2);
  });

  it('exits 1 when reviewer not dispatched (independence violation, empty transcript)', () => {
    const root = setup();
    // No fake home → loadScannedAgents returns empty Set → submitVerdict rejects.
    const home = fakeHomeWithTranscript(root, []);
    const r = spawnSync('node', [CLI, '--agent', 'aaa-art-director', '--status', 'GO'], {
      cwd: root,
      env: { ...process.env, HOME: home },
    });
    expect(r.status).toBe(1);
    expect(r.stderr.toString()).toMatch(/independence/);
  });

  it('exits 0 when reviewer was dispatched (transcript contains matching subagent_type)', () => {
    const root = setup();
    const home = fakeHomeWithTranscript(root, ['aaa-art-director']);
    const r = spawnSync('node', [CLI, '--agent', 'aaa-art-director', '--status', 'GO', '--text', 'looks good'], {
      cwd: root,
      env: { ...process.env, HOME: home },
    });
    expect(r.status).toBe(0);
    expect(r.stdout.toString()).toMatch(/achieved → next cursor: t2/);
  });

  it('exits 0 on escape-hatch REVISE (unavailable; ...)', () => {
    const root = setup();
    const home = fakeHomeWithTranscript(root, []);
    const r = spawnSync('node', [CLI,
      '--agent', 'aaa-art-director', '--status', 'REVISE',
      '--text', 'unavailable; user must run /goal-approve',
    ], {
      cwd: root,
      env: { ...process.env, HOME: home },
    });
    expect(r.status).toBe(0);
    // Cursor not advanced (escape-hatch transitions to blocked + awaiting-manual-approval)
    expect(r.stdout.toString()).toMatch(/verdict recorded, cursor status: blocked/);
  });
});
