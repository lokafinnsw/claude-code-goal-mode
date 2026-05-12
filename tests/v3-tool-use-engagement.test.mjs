/**
 * v3.0.6 regression suite — tool_use counts as engagement in
 * auto-pause-on-silence detection.
 *
 * Closes a false-positive in v2.0.6 reported by user 2026-05-12:
 *
 *   Pre-v3.0.6, the Stop hook treated "no goal-mode tag emission this
 *   turn" as silence. Controllers doing legitimate exploration work
 *   (Bash to run tests, Read to inspect source, Edit to fix code, Agent
 *   to dispatch reviewers) emit ZERO goal-mode tags per-turn during
 *   setup phases. Only the final "achieve" turn emits tags. Multi-turn
 *   exploration (25+ turns is normal for complex tasks) accumulated
 *   false-positive silence and auto-paused.
 *
 *   Raising silenceThreshold (v3.0.5: 5→20) just delayed the same
 *   false-positive on slightly longer exploration phases.
 *
 *   v3.0.6: any tool_use block in the turn's scan window counts as
 *   engagement. Tag-emission events stay primary; tool_use is a
 *   secondary engagement signal that prevents false-positives.
 *
 *   The 7 cases below pin every important shape of the new behavior.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runStopHook } from '../engine/stop-hook.mjs';
import { saveState, saveTree, loadState } from '../engine/state.mjs';
import { activeDir, notesPath } from '../engine/paths.mjs';

const TS = '2026-05-12T00:00:00.000Z';

function mkRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'v306-toolu-'));
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

function mkState(overrides = {}) {
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
    ...overrides,
  };
}

function setupProject(stateOverrides = {}) {
  const root = mkRoot();
  fs.mkdirSync(activeDir(root), { recursive: true });
  saveTree(root, mkTree());
  saveState(root, mkState(stateOverrides));
  // Pin stopHookDriver=true so the v3 default null-stdout short-circuit
  // doesn't fire (we need the silence-detection block to actually run).
  // silenceThreshold=5 keeps the test inputs compact (4 silent → next
  // turn pauses) without changing trigger logic.
  fs.writeFileSync(
    path.join(activeDir(root), 'config.json'),
    JSON.stringify({ schema_version: 1, stopHookDriver: true, silenceThreshold: 5 }),
  );
  fs.writeFileSync(notesPath(root), '');
  return root;
}

/**
 * Write a transcript with a single assistant row containing the given
 * content blocks. Content blocks describe what was in the turn:
 *   { type: 'text', text: '...' }
 *   { type: 'tool_use', name: 'Bash', input: {} }
 */
function writeTranscript(dir, contentBlocks) {
  const tp = path.join(dir, 'transcript.jsonl');
  fs.writeFileSync(
    tp,
    JSON.stringify({
      timestamp: TS,
      message: {
        role: 'assistant',
        content: contentBlocks,
      },
    }) + '\n',
  );
  return tp;
}

describe('v3.0.6: tool_use counts as engagement', () => {
  it('Bash-only turn does NOT increment silent-turn counter', async () => {
    const root = setupProject({ consecutive_silent_turns: 4 });
    const tp = writeTranscript(root, [
      { type: 'text', text: 'running tests' },
      { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } },
    ]);
    await runStopHook({ stdin: { session_id: 's', transcript_path: tp }, projectRoot: root });
    const after = loadState(root);
    // Counter resets to 0 (Bash tool_use = engagement), NOT 5 (which would auto-pause).
    expect(after.consecutive_silent_turns).toBe(0);
    expect(after.lifecycle).toBe('pursuing');
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('Read-only turn does NOT increment silent-turn counter', async () => {
    const root = setupProject({ consecutive_silent_turns: 4 });
    const tp = writeTranscript(root, [
      { type: 'tool_use', name: 'Read', input: { file_path: '/x.ts' } },
    ]);
    await runStopHook({ stdin: { session_id: 's', transcript_path: tp }, projectRoot: root });
    const after = loadState(root);
    expect(after.consecutive_silent_turns).toBe(0);
    expect(after.lifecycle).toBe('pursuing');
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('Edit + Bash multi-tool turn does NOT increment silent-turn counter', async () => {
    const root = setupProject({ consecutive_silent_turns: 4 });
    const tp = writeTranscript(root, [
      { type: 'text', text: 'fixing then re-testing' },
      { type: 'tool_use', name: 'Edit', input: { file_path: '/x.ts' } },
      { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } },
    ]);
    await runStopHook({ stdin: { session_id: 's', transcript_path: tp }, projectRoot: root });
    const after = loadState(root);
    expect(after.consecutive_silent_turns).toBe(0);
    expect(after.lifecycle).toBe('pursuing');
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('pure-text turn (no tools, no tags) DOES increment counter', async () => {
    const root = setupProject({ consecutive_silent_turns: 3 });
    const tp = writeTranscript(root, [
      { type: 'text', text: 'just thinking out loud, no tools, no tags' },
    ]);
    await runStopHook({ stdin: { session_id: 's', transcript_path: tp }, projectRoot: root });
    const after = loadState(root);
    // No engagement → counter increments 3 → 4 (still below threshold=5).
    expect(after.consecutive_silent_turns).toBe(4);
    expect(after.lifecycle).toBe('pursuing');
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('tool_use + goal-mode tags = still engagement (counter resets, single reset)', async () => {
    const root = setupProject({ consecutive_silent_turns: 4 });
    const tp = writeTranscript(root, [
      {
        type: 'text',
        text: '<evidence file="x.ts" criterion="0" note="proof"/><task-status>pursuing</task-status>',
      },
      { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } },
    ]);
    await runStopHook({ stdin: { session_id: 's', transcript_path: tp }, projectRoot: root });
    const after = loadState(root);
    // Counter resets to 0 — both signals fire, but it's a single reset
    // (the engagement check is OR, not additive).
    expect(after.consecutive_silent_turns).toBe(0);
    expect(after.lifecycle).toBe('pursuing');
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('empty transcript (no content blocks at all) DOES increment counter', async () => {
    const root = setupProject({ consecutive_silent_turns: 3 });
    const tp = path.join(root, 'transcript.jsonl');
    // Assistant row with empty content array — no text, no tools, no tags.
    fs.writeFileSync(
      tp,
      JSON.stringify({
        timestamp: TS,
        message: { role: 'assistant', content: [] },
      }) + '\n',
    );
    await runStopHook({ stdin: { session_id: 's', transcript_path: tp }, projectRoot: root });
    const after = loadState(root);
    expect(after.consecutive_silent_turns).toBe(4);
    expect(after.lifecycle).toBe('pursuing');
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('v2.0.6 trigger preserved: pure-text turn AT threshold auto-pauses', async () => {
    // Regression check: the auto-pause path still fires when there's
    // genuine silence (no tools AND no tags). v3.0.6 only relaxes
    // false-positives; it must not break the real trigger.
    const root = setupProject({ consecutive_silent_turns: 4 });
    const tp = writeTranscript(root, [
      { type: 'text', text: 'не лезу' },
    ]);
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = () => true;
    try {
      await runStopHook({ stdin: { session_id: 's', transcript_path: tp }, projectRoot: root });
    } finally {
      process.stderr.write = origWrite;
    }
    const after = loadState(root);
    expect(after.lifecycle).toBe('paused');
    expect(after.consecutive_silent_turns).toBe(5);
    const pauseEvent = [...after.history].reverse().find((h) => h.event === 'paused');
    expect(pauseEvent.payload.reason).toBe('auto-paused-on-silence');
    fs.rmSync(root, { recursive: true, force: true });
  });
});
