import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { saveTree, saveState, loadState } from '../engine/state.mjs';
import { activeDir } from '../engine/paths.mjs';
import { runStopHook } from '../engine/stop-hook.mjs';

function makeApprovedTree() {
  return {
    schema_version: 2,
    goal_id: 'phase-8-e2e',
    mission: 'Multi-turn flow to test budget accumulation.',
    created_at: new Date().toISOString(),
    approved_at: new Date().toISOString(),
    root: {
      id: 's', type: 'sprint', title: 'Sprint 1', goal: 'Multi-task.',
      acceptance_criteria: [], review: [], validate: null,
      work_front: 'engine', status: 'pursuing',
      evidence: [], blocker_reason: null, review_attempts: 0, notes: [],
      children: [
        {
          id: 's.t1', type: 'task', title: 'Task 1',
          goal: 'First task in the chain.', acceptance_criteria: ['c0'],
          review: [], validate: null,
          work_front: 'engine', status: 'pursuing',
          evidence: [], blocker_reason: null, review_attempts: 0, notes: [],
          children: [],
        },
        {
          id: 's.t2', type: 'task', title: 'Task 2',
          goal: 'Second task in the chain.', acceptance_criteria: ['c0'],
          review: [], validate: null,
          work_front: 'engine', status: 'pending',
          evidence: [], blocker_reason: null, review_attempts: 0, notes: [],
          children: [],
        },
      ],
    },
  };
}

function pursuingState(opts = {}) {
  return {
    schema_version: 2,
    goal_id: 'phase-8-e2e',
    lifecycle: 'pursuing',
    cursor: 's.t1',
    budget: {
      iterations: { used: 0, max: opts.maxIter ?? 100 },
      tokens: { used: 0, max: opts.maxTokens ?? 1_000_000 },
      wallclock: {
        started_at: opts.startedAt ?? new Date().toISOString(),
        max_seconds: opts.maxSeconds ?? 14400,
      },
    },
    session_id: 'sess-phase8',
    started_at: new Date().toISOString(),
    paused_at: null,
    ended_at: null,
    ended_reason: null,
    history: [],
  };
}

function setupProject(tree, state) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phase8-e2e-'));
  saveTree(root, tree);
  saveState(root, state);
  // v3.0: these tests exercise the legacy Stop-hook driver path
  // (continuation injection on lifecycle=pursuing). Pin the fixture
  // to stopHookDriver=true so the v3 default short-circuit (null
  // stdout on pursuing) doesn't fire.
  fs.writeFileSync(
    path.join(activeDir(root), 'config.json'),
    JSON.stringify({ schema_version: 1, stopHookDriver: true }),
  );
  return root;
}

function writeTranscript(root, rows) {
  const tPath = path.join(root, 'transcript.jsonl');
  fs.writeFileSync(tPath, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  return tPath;
}

function assistantRow({ text = 'no tags', usage = {} } = {}) {
  return {
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
      usage: {
        input_tokens: usage.input ?? 0,
        output_tokens: usage.output ?? 0,
        cache_creation_input_tokens: usage.cacheCreate ?? 0,
        cache_read_input_tokens: usage.cacheRead ?? 0,
      },
    },
  };
}

describe('Phase 8 E2E — multi-turn budget exhaustion', () => {
  it('token tally accumulates across turns; budget-limit fires when threshold is crossed', async () => {
    const root = setupProject(
      makeApprovedTree(),
      pursuingState({ maxTokens: 1000 })
    );

    // Turn 1: 300 tokens used (cumulative 300, well within budget).
    let tPath = writeTranscript(root, [assistantRow({ usage: { input: 200, output: 100 } })]);
    let result = await runStopHook({
      stdin: { session_id: 'sess-phase8', transcript_path: tPath },
      projectRoot: root,
    });
    expect(result.stdout.systemMessage).toMatch(/🎯/);  // normal pursuing
    let state = loadState(root);
    expect(state.lifecycle).toBe('pursuing');
    expect(state.budget.tokens.used).toBe(300);
    expect(state.budget.iterations.used).toBe(1);

    // Turn 2: cumulative 600 tokens. Still within budget.
    tPath = writeTranscript(root, [
      assistantRow({ usage: { input: 200, output: 100 } }),
      assistantRow({ usage: { input: 200, output: 100 } }),
    ]);
    result = await runStopHook({
      stdin: { session_id: 'sess-phase8', transcript_path: tPath },
      projectRoot: root,
    });
    expect(result.stdout.systemMessage).toMatch(/🎯/);
    state = loadState(root);
    expect(state.lifecycle).toBe('pursuing');
    expect(state.budget.tokens.used).toBe(600);

    // Turn 3: cumulative tokens jump to 1100 (exceeds 1000 max).
    tPath = writeTranscript(root, [
      assistantRow({ usage: { input: 200, output: 100 } }),
      assistantRow({ usage: { input: 200, output: 100 } }),
      assistantRow({ usage: { input: 300, output: 200 } }),
    ]);
    result = await runStopHook({
      stdin: { session_id: 'sess-phase8', transcript_path: tPath },
      projectRoot: root,
    });
    expect(result.stdout.systemMessage).toBe('🟡 tokens budget exhausted');
    expect(result.stdout.reason).toContain('tokens');

    state = loadState(root);
    expect(state.lifecycle).toBe('budget-limited');
    expect(state.ended_reason).toBe('tokens budget exhausted');
    expect(state.budget.tokens.used).toBe(1100);
    expect(state.budget.iterations.used).toBe(3);
    const lastEvent = state.history[state.history.length - 1];
    expect(lastEvent.event).toBe('budget-exhausted');
    expect(lastEvent.payload.kind).toBe('tokens');
  });

  it('after budget-limited, subsequent Stop hooks silently exit (lifecycle gate)', async () => {
    const root = setupProject(
      makeApprovedTree(),
      pursuingState({ maxTokens: 100 })
    );

    // Turn 1: exceed token budget immediately.
    let tPath = writeTranscript(root, [assistantRow({ usage: { input: 100, output: 100 } })]);
    let result = await runStopHook({
      stdin: { session_id: 'sess-phase8', transcript_path: tPath },
      projectRoot: root,
    });
    expect(result.stdout.systemMessage).toMatch(/budget exhausted/);
    let state = loadState(root);
    expect(state.lifecycle).toBe('budget-limited');

    // Turn 2: another assistant turn fires Stop hook. Lifecycle gate
    // should short-circuit BEFORE the budget check.
    tPath = writeTranscript(root, [
      assistantRow({ usage: { input: 100, output: 100 } }),
      assistantRow({ usage: { input: 100, output: 100 } }),
    ]);
    result = await runStopHook({
      stdin: { session_id: 'sess-phase8', transcript_path: tPath },
      projectRoot: root,
    });
    // Lifecycle is no longer 'pursuing' → silent exit, no stdout.
    expect(result.exit).toBe(0);
    expect(result.stdout).toBeNull();

    // State unchanged — iterations counter NOT incremented after budget hit.
    state = loadState(root);
    expect(state.lifecycle).toBe('budget-limited');
    expect(state.budget.iterations.used).toBe(1);  // still 1 — no further increments
  });

  it('iterations budget triggers exhaustion after exact count of turns', async () => {
    const root = setupProject(
      makeApprovedTree(),
      pursuingState({ maxIter: 3 })
    );

    // Turn 1, 2: pursuing.
    for (let i = 1; i <= 2; i++) {
      const tPath = writeTranscript(root, [assistantRow({ text: `turn ${i}` })]);
      const result = await runStopHook({
        stdin: { session_id: 'sess-phase8', transcript_path: tPath },
        projectRoot: root,
      });
      expect(result.stdout.systemMessage).toMatch(/🎯/);
      const state = loadState(root);
      expect(state.lifecycle).toBe('pursuing');
      expect(state.budget.iterations.used).toBe(i);
    }

    // Turn 3: increment hits 3 == max, budget-limit fires.
    const tPath = writeTranscript(root, [assistantRow({ text: 'turn 3' })]);
    const result = await runStopHook({
      stdin: { session_id: 'sess-phase8', transcript_path: tPath },
      projectRoot: root,
    });
    expect(result.stdout.systemMessage).toBe('🟡 iterations budget exhausted');

    const state = loadState(root);
    expect(state.lifecycle).toBe('budget-limited');
    expect(state.budget.iterations.used).toBe(3);
    expect(state.ended_reason).toBe('iterations budget exhausted');
  });
});
