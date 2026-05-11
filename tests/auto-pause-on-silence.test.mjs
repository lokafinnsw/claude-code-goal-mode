/**
 * v2.0.6 regression suite — auto-pause-on-silence.
 *
 * Closes the controller-not-engaging spam loop user-reported 2026-05-12:
 *   - Setup: a goal is in `pursuing` lifecycle. The controller agent
 *     (driving Claude session) has a user-level rule that tells it not
 *     to engage with the goal in this specific session (e.g., memory
 *     rule "Не лезь в игру"). Per turn, the controller emits minimum-text
 *     responses with NO goal-mode tags.
 *   - Pre-v2.0.6: Stop hook fires `continuation.md` every turn. Cursor
 *     doesn't advance (no tags), state doesn't transition (no tags), and
 *     the engine has no signal to stop firing. Token budget bleeds.
 *   - v2.0.6: stop-hook counts engagement events in turnHistory; when
 *     state.consecutive_silent_turns >= 5, auto-transition to `paused`
 *     with payload.reason='auto-paused-on-silence'. Subsequent Stop-hook
 *     ticks return null stdout (existing lifecycle gate). `/goal-resume`
 *     resets the counter to 0 and restores `pursuing`.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runStopHook } from '../engine/stop-hook.mjs';
import { runSessionStartHook } from '../engine/session-start-hook.mjs';
import { resumeGoal } from '../engine/lifecycle-commands.mjs';
import { checkAutoPausedOnSilence } from '../engine/doctor.mjs';
import { saveState, saveTree, loadState } from '../engine/state.mjs';
import { activeDir, statePath, treePath, notesPath } from '../engine/paths.mjs';

const TS = '2026-05-12T00:00:00.000Z';

function mkRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'v206-aps-'));
}

function mkTree() {
  return {
    schema_version: 2,
    goal_id: 'g',
    mission: 'm',
    created_at: '2026-05-10T00:00:00.000Z',
    approved_at: '2026-05-10T00:00:00.000Z',
    root: {
      id: 'sprint-1', type: 'sprint', title: 'S', goal: 'g',
      acceptance_criteria: [], review: [], validate: null, work_front: null,
      status: 'pursuing', evidence: [], blocker_reason: null, review_attempts: 0, notes: [],
      children: [
        {
          id: 't', type: 'task', title: 't', goal: 'tg',
          acceptance_criteria: ['c0'],
          review: [], validate: null, work_front: null,
          status: 'pursuing',
          evidence: [],
          blocker_reason: null,
          review_attempts: 0,
          notes: [],
          children: [],
        },
      ],
    },
  };
}

function mkState() {
  return {
    schema_version: 2,
    goal_id: 'g',
    lifecycle: 'pursuing',
    cursor: 't',
    budget: {
      iterations: { used: 1, max: 100 },
      tokens: { used: 0, max: 0 },
      wallclock: { started_at: new Date().toISOString(), max_seconds: 30 * 86400 },
    },
    session_id: 's',
    started_at: new Date().toISOString(),
    paused_at: null,
    ended_at: null,
    ended_reason: null,
    history: [],
    consecutive_silent_turns: 0,
  };
}

function setupProject() {
  const root = mkRoot();
  fs.mkdirSync(activeDir(root), { recursive: true });
  saveTree(root, mkTree());
  saveState(root, mkState());
  fs.writeFileSync(notesPath(root), '');
  return root;
}

function writeSilentTranscript(dir) {
  const tp = path.join(dir, 'transcript.jsonl');
  // Assistant message with NO goal-mode tags.
  fs.writeFileSync(
    tp,
    JSON.stringify({
      timestamp: TS,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'не лезу' }],
      },
    }) + '\n',
  );
  return tp;
}

function writeEngagedTranscript(dir) {
  const tp = path.join(dir, 'transcript.jsonl');
  fs.writeFileSync(
    tp,
    JSON.stringify({
      timestamp: TS,
      message: {
        role: 'assistant',
        content: [{
          type: 'text',
          text: '<evidence file="x.ts" criterion="0" note="proof"/><task-status>pursuing</task-status>',
        }],
      },
    }) + '\n',
  );
  return tp;
}

describe('v2.0.6: silent-turn counter increments and triggers auto-pause', () => {
  it('first silent turn → counter=1, lifecycle stays pursuing', async () => {
    const root = setupProject();
    const tp = writeSilentTranscript(root);
    await runStopHook({ stdin: { session_id: 's', transcript_path: tp }, projectRoot: root });
    const after = loadState(root);
    expect(after.consecutive_silent_turns).toBe(1);
    expect(after.lifecycle).toBe('pursuing');
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('engagement turn resets counter to 0', async () => {
    const root = setupProject();
    // Pre-load state with counter at 3.
    const state = mkState();
    state.consecutive_silent_turns = 3;
    saveState(root, state);
    const tp = writeEngagedTranscript(root);
    await runStopHook({ stdin: { session_id: 's', transcript_path: tp }, projectRoot: root });
    const after = loadState(root);
    expect(after.consecutive_silent_turns).toBe(0);
    expect(after.lifecycle).toBe('pursuing');
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('5th silent turn auto-pauses with reason=auto-paused-on-silence', async () => {
    const root = setupProject();
    const state = mkState();
    state.consecutive_silent_turns = 4;
    saveState(root, state);
    const tp = writeSilentTranscript(root);

    // Silence stderr for the auto-pause diagnostic.
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = () => true;
    let result;
    try {
      result = await runStopHook({ stdin: { session_id: 's', transcript_path: tp }, projectRoot: root });
    } finally {
      process.stderr.write = origWrite;
    }
    const after = loadState(root);
    expect(after.lifecycle).toBe('paused');
    expect(after.consecutive_silent_turns).toBe(5);
    const pauseEvent = [...after.history].reverse().find((h) => h.event === 'paused');
    expect(pauseEvent.payload.reason).toBe('auto-paused-on-silence');
    expect(pauseEvent.payload.silent_turns).toBe(5);
    // Stop-hook returned a render (the auto-paused-on-silence.md template).
    expect(result.stdout).toBeTruthy();
    expect(result.stdout.systemMessage).toMatch(/auto-paused/i);
    expect(result.stdout.reason).toMatch(/auto-paused/i);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('subsequent Stop-hook ticks after auto-pause return null stdout (no spam)', async () => {
    const root = setupProject();
    // Pre-set to paused via auto-pause (simulating the second tick after the transition).
    const state = mkState();
    state.lifecycle = 'paused';
    state.paused_at = TS;
    state.consecutive_silent_turns = 5;
    state.history = [{
      ts: TS, iteration: 5, event: 'paused', node_id: 't',
      payload: { reason: 'auto-paused-on-silence', silent_turns: 5 },
    }];
    saveState(root, state);
    const tp = writeSilentTranscript(root);
    const result = await runStopHook({ stdin: { session_id: 's', transcript_path: tp }, projectRoot: root });
    expect(result.stdout).toBeNull();
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('v2.0.6: /goal-resume restores pursuing and resets counter', () => {
  it('resume sets lifecycle=pursuing and consecutive_silent_turns=0', () => {
    const root = setupProject();
    const state = mkState();
    state.lifecycle = 'paused';
    state.paused_at = TS;
    state.consecutive_silent_turns = 5;
    saveState(root, state);

    const result = resumeGoal(root);
    expect(result.ok).toBe(true);
    const after = loadState(root);
    expect(after.lifecycle).toBe('pursuing');
    expect(after.consecutive_silent_turns).toBe(0);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('v2.0.6: SessionStart surfaces auto-paused-on-silence', () => {
  it('emits clear additionalContext explaining the auto-pause + 3 recovery options', async () => {
    const root = setupProject();
    const state = mkState();
    state.lifecycle = 'paused';
    state.consecutive_silent_turns = 5;
    state.history = [{
      ts: TS, iteration: 5, event: 'paused', node_id: 't',
      payload: { reason: 'auto-paused-on-silence', silent_turns: 5 },
    }];
    saveState(root, state);
    const result = await runSessionStartHook({ stdin: { session_id: 's' }, projectRoot: root });
    expect(result.stdout).toBeTruthy();
    const ctx = result.stdout.hookSpecificOutput.additionalContext;
    expect(ctx).toMatch(/AUTO-PAUSED/i);
    expect(ctx).toMatch(/\/goal-mode:goal-resume/);
    expect(ctx).toMatch(/\/goal-mode:goal-abandon/);
    expect(ctx).toMatch(/\/goal-mode:goal-clear/);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('user-initiated /goal-pause (not auto) returns null stdout (existing behavior)', async () => {
    const root = setupProject();
    const state = mkState();
    state.lifecycle = 'paused';
    state.history = [{
      ts: TS, iteration: 1, event: 'paused', node_id: 't',
      payload: {}, // no auto-paused-on-silence reason
    }];
    saveState(root, state);
    const result = await runSessionStartHook({ stdin: { session_id: 's' }, projectRoot: root });
    expect(result.stdout).toBeNull();
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('v2.0.6: doctor check', () => {
  it('warns when goal was auto-paused-on-silence', () => {
    const root = setupProject();
    const state = mkState();
    state.lifecycle = 'paused';
    state.history = [{
      ts: TS, iteration: 5, event: 'paused', node_id: 't',
      payload: { reason: 'auto-paused-on-silence', silent_turns: 5 },
    }];
    saveState(root, state);
    const result = checkAutoPausedOnSilence(root);
    expect(result.status).toBe('warn');
    expect(result.message).toMatch(/AUTO-paused after 5 silent turns/);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('returns ok when goal is paused by user (not auto)', () => {
    const root = setupProject();
    const state = mkState();
    state.lifecycle = 'paused';
    state.history = [{ ts: TS, iteration: 1, event: 'paused', node_id: 't', payload: {} }];
    saveState(root, state);
    const result = checkAutoPausedOnSilence(root);
    expect(result.status).toBe('ok');
    expect(result.message).toMatch(/paused by user, not auto-paused/);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('returns ok when goal is pursuing', () => {
    const root = setupProject();
    const result = checkAutoPausedOnSilence(root);
    expect(result.status).toBe('ok');
    expect(result.message).toMatch(/not paused/);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('v2.0.6: backward compatibility with pre-v2.0.6 state.json', () => {
  it('state.json missing consecutive_silent_turns field gets default=0 on load', () => {
    const root = setupProject();
    // Manually write state.json WITHOUT the new field (simulating v2.0.5 state).
    const sp = statePath(root);
    const oldState = JSON.parse(fs.readFileSync(sp, 'utf8'));
    delete oldState.consecutive_silent_turns;
    fs.writeFileSync(sp, JSON.stringify(oldState, null, 2));
    const loaded = loadState(root);
    expect(loaded.consecutive_silent_turns).toBe(0);
    fs.rmSync(root, { recursive: true, force: true });
  });
});
