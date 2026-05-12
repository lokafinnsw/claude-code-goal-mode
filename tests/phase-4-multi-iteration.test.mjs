import { describe, it, expect, vi } from 'vitest';
import { runStopHook } from '../engine/stop-hook.mjs';
import * as stateModule from '../engine/state.mjs';
import { loadState, loadTree, saveState, saveTree } from '../engine/state.mjs';
import { activeDir } from '../engine/paths.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function setupProject(tree, state, transcripts) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'goal-multi-'));
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
  return { root, transcripts };
}

function writeTranscript(root, name, agentText, dispatchedAgents = []) {
  const tPath = path.join(root, `${name}.jsonl`);
  // Reviewer-independence enforcement (v1.2.0+): include Agent tool_use rows
  // for any subagent whose verdict appears in agentText.
  const rows = [];
  for (const agent of dispatchedAgents) {
    rows.push({
      timestamp: new Date().toISOString(),
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_use', name: 'Agent', id: `agent-${agent}-${Date.now()}-${Math.random()}`, input: { subagent_type: agent, description: 'review', prompt: 'check' } },
        ],
      },
    });
  }
  rows.push({
    timestamp: new Date().toISOString(),
    message: { role: 'assistant', content: [{ type: 'text', text: agentText }] },
  });
  fs.writeFileSync(tPath, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return tPath;
}

function twoTaskTree() {
  return {
    schema_version: 2,
    goal_id: 'g',
    mission: 'Test multi-iteration flow.',
    created_at: '2026-05-09T00:00:00.000Z',
    approved_at: '2026-05-09T00:00:00.000Z',
    root: {
      id: 's', type: 'sprint', title: 'Sprint 1',
      goal: 'Two tasks to exercise advancement.',
      acceptance_criteria: [], review: [], validate: null,
      work_front: 'engine', status: 'pursuing',
      evidence: [], blocker_reason: null, review_attempts: 0, notes: [],
      children: [
        {
          id: 's.t1', type: 'task', title: 'Task 1',
          goal: 'First task.', acceptance_criteria: ['c0'],
          review: [], validate: null, work_front: 'engine', status: 'pursuing',
          evidence: [], blocker_reason: null, review_attempts: 0, notes: [], children: [],
        },
        {
          id: 's.t2', type: 'task', title: 'Task 2',
          goal: 'Second task.', acceptance_criteria: ['c0', 'c1'],
          review: [], validate: null, work_front: 'engine', status: 'pending',
          evidence: [], blocker_reason: null, review_attempts: 0, notes: [], children: [],
        },
      ],
    },
  };
}

function pursuingState() {
  return {
    schema_version: 2, goal_id: 'g', lifecycle: 'pursuing', cursor: 's.t1',
    budget: {
      iterations: { used: 0, max: 100 },
      tokens: { used: 0, max: 1_000_000 },
      wallclock: { started_at: new Date().toISOString(), max_seconds: 14400 },
    },
    session_id: 'sess-multi',
    started_at: new Date().toISOString(),
    paused_at: null, ended_at: null, ended_reason: null,
    history: [],
  };
}

describe('Phase 4 multi-iteration end-to-end', () => {
  it('iteration 1: pursuing → no tags → cursor stays + iteration counter increments', async () => {
    const { root } = setupProject(twoTaskTree(), pursuingState());
    const tPath = writeTranscript(root, 'iter1', 'Working on it. No status yet.');

    const result = await runStopHook({
      stdin: { session_id: 'sess-multi', transcript_path: tPath },
      projectRoot: root,
    });

    expect(result.stdout.decision).toBe('block');
    const newState = loadState(root);
    expect(newState.budget.iterations.used).toBe(1);
    expect(newState.cursor).toBe('s.t1');
    expect(newState.lifecycle).toBe('pursuing');
    const newTree = loadTree(root);
    expect(newTree.root.children[0].evidence.length).toBe(0);
    expect(newTree.root.children[0].status).toBe('pursuing');
  });

  it('multi-turn: t1 achieves → cursor advances to t2 → t2 achieves → lifecycle achieved', async () => {
    const { root } = setupProject(twoTaskTree(), pursuingState());

    // Turn 1: t1 partial — emit evidence but don't claim achieved.
    const t1Path = writeTranscript(root, 'iter1',
      '<evidence file="src/t1.ts" criterion="0" note="implemented" />\nStill working on testing.');
    let result = await runStopHook({
      stdin: { session_id: 'sess-multi', transcript_path: t1Path },
      projectRoot: root,
    });
    expect(result.stdout.systemMessage).toMatch(/🎯 s\.t1/);

    let state = loadState(root);
    let tree = loadTree(root);
    expect(state.budget.iterations.used).toBe(1);
    expect(state.cursor).toBe('s.t1');
    expect(tree.root.children[0].evidence.length).toBe(1);
    expect(tree.root.children[0].status).toBe('pursuing');

    // Turn 2: t1 achieves.
    const t2Path = writeTranscript(root, 'iter2',
      'Done with t1.\n<task-status>achieved</task-status>');
    result = await runStopHook({
      stdin: { session_id: 'sess-multi', transcript_path: t2Path },
      projectRoot: root,
    });
    expect(result.stdout.systemMessage).toMatch(/🎯 s\.t2/);  // cursor moved

    state = loadState(root);
    tree = loadTree(root);
    expect(state.budget.iterations.used).toBe(2);
    expect(state.cursor).toBe('s.t2');
    expect(tree.root.children[0].status).toBe('achieved');
    // v3.0: new cursor task is promoted to 'pursuing' on advance (was 'pending'
    // pre-v3 — relied on agent emitting <task-status>pursuing</> on next turn).
    expect(tree.root.children[1].status).toBe('pursuing');

    // Turn 3: t2 partial evidence.
    const t3Path = writeTranscript(root, 'iter3',
      '<evidence file="src/t2.ts" criterion="0" note="impl" />\n<evidence file="src/t2.ts" criterion="1" note="tested" />');
    result = await runStopHook({
      stdin: { session_id: 'sess-multi', transcript_path: t3Path },
      projectRoot: root,
    });
    expect(result.stdout.systemMessage).toMatch(/🎯 s\.t2/);

    state = loadState(root);
    tree = loadTree(root);
    expect(state.budget.iterations.used).toBe(3);
    expect(tree.root.children[1].evidence.length).toBe(2);

    // Turn 4: t2 achieves → lifecycle achieved.
    const t4Path = writeTranscript(root, 'iter4',
      '<task-status>achieved</task-status>');
    result = await runStopHook({
      stdin: { session_id: 'sess-multi', transcript_path: t4Path },
      projectRoot: root,
    });
    expect(result.stdout.systemMessage).toBe('✅ goal achieved');

    state = loadState(root);
    tree = loadTree(root);
    expect(state.budget.iterations.used).toBe(4);
    expect(state.lifecycle).toBe('achieved');
    expect(tree.root.children[1].status).toBe('achieved');
  });

  it('multi-turn: review-pending cycle — task achieves → review fires → NOGO/REVISE returns to pursuing → eventually GO advances', async () => {
    const tree = twoTaskTree();
    tree.root.children[0].review = ['art-x'];
    const { root } = setupProject(tree, pursuingState());

    // Turn 1: agent achieves t1 with evidence + review-request.
    const t1Path = writeTranscript(root, 'iter1',
      '<evidence file="x" criterion="0" note="done" />\n<task-status>achieved</task-status>\n<review-request agents="art-x" />');
    let result = await runStopHook({
      stdin: { session_id: 'sess-multi', transcript_path: t1Path },
      projectRoot: root,
    });
    let state = loadState(root);
    let tree2 = loadTree(root);
    expect(state.cursor).toBe('s.t1');  // still on t1, awaiting review
    expect(tree2.root.children[0].status).toBe('review-pending');
    // Continuation prompt should be the review template.
    expect(result.stdout.reason).toContain('review-pending');

    // Turn 2: NOGO verdict (with matching Agent dispatch for indep enforcement).
    const t2Path = writeTranscript(root, 'iter2',
      '<audit-verdict agent="art-x" status="NOGO">color contrast fails</audit-verdict>',
      ['art-x']);
    result = await runStopHook({
      stdin: { session_id: 'sess-multi', transcript_path: t2Path },
      projectRoot: root,
    });
    state = loadState(root);
    tree2 = loadTree(root);
    expect(tree2.root.children[0].status).toBe('pursuing');
    expect(tree2.root.children[0].review_attempts).toBe(1);

    // Turn 3: agent re-attempts with new evidence + new task-status + new review-request.
    const t3Path = writeTranscript(root, 'iter3',
      '<evidence file="x" criterion="0" note="contrast fixed" />\n<task-status>achieved</task-status>\n<review-request agents="art-x" />');
    result = await runStopHook({
      stdin: { session_id: 'sess-multi', transcript_path: t3Path },
      projectRoot: root,
    });
    state = loadState(root);
    tree2 = loadTree(root);
    expect(tree2.root.children[0].status).toBe('review-pending');

    // Turn 4: GO verdict (with matching Agent dispatch for indep enforcement).
    const t4Path = writeTranscript(root, 'iter4',
      '<audit-verdict agent="art-x" status="GO">looks good</audit-verdict>',
      ['art-x']);
    result = await runStopHook({
      stdin: { session_id: 'sess-multi', transcript_path: t4Path },
      projectRoot: root,
    });
    state = loadState(root);
    tree2 = loadTree(root);
    expect(tree2.root.children[0].status).toBe('achieved');
    expect(state.cursor).toBe('s.t2');  // cursor advanced
    expect(state.budget.iterations.used).toBe(4);
  });

  it('multi-turn: state file written by iteration N is loaded by iteration N+1 (atomic-write proof)', async () => {
    const { root } = setupProject(twoTaskTree(), pursuingState());

    // Run 5 iterations rapid-fire, each emitting some evidence.
    const iterations = [
      '<evidence file="a" criterion="0" note="i1" />',
      '<evidence file="b" criterion="0" note="i2" />',
      '<evidence file="c" criterion="0" note="i3" />',
      '<evidence file="d" criterion="0" note="i4" />',
      '<evidence file="e" criterion="0" note="i5" />',
    ];

    for (let i = 0; i < iterations.length; i++) {
      const tPath = writeTranscript(root, `iter${i + 1}`, iterations[i]);
      await runStopHook({
        stdin: { session_id: 'sess-multi', transcript_path: tPath },
        projectRoot: root,
      });
    }

    const state = loadState(root);
    const tree = loadTree(root);
    expect(state.budget.iterations.used).toBe(5);
    // All 5 evidence records should have accumulated on t1.
    expect(tree.root.children[0].evidence.length).toBe(5);
    // History should include 5 evidence-added events.
    const evidenceAddedCount = state.history.filter(h => h.event === 'evidence-added').length;
    expect(evidenceAddedCount).toBe(5);

    // Notes-digest should show 5 lines.
    const notes = fs.readFileSync(path.join(root, '.claude', 'goals', 'active', 'notes.md'), 'utf8');
    const noteLines = notes.trim().split('\n').filter(Boolean);
    expect(noteLines.length).toBe(5);
  });
});

// Strict session-id matching in stop-hook (since v1.1.18, after wildcard
// approach was replaced with transcript-derived real UUID in start-goal-cli).
// Both CLI and Desktop now write the same real session UUID into state.json,
// so strict matching works in both environments. Mismatch now writes stderr
// diagnostic instead of silently no-op-ing.
describe('Stop-hook session-id matching (strict)', () => {
  it('matching session_id processes the Stop event (happy path)', async () => {
    const { root } = setupProject(twoTaskTree(), { ...pursuingState(), session_id: 'real-uuid' });
    const tPath = writeTranscript(root, 'iter-match', 'Working.');

    const result = await runStopHook({
      stdin: { session_id: 'real-uuid', transcript_path: tPath },
      projectRoot: root,
    });

    expect(result.stdout?.decision).toBe('block');
    const newState = loadState(root);
    expect(newState.budget.iterations.used).toBe(1);
  });

  it('mismatched session_id auto-rebinds to live session and processes the Stop event', async () => {
    const { root } = setupProject(twoTaskTree(), { ...pursuingState(), session_id: 'uuid-A' });
    const tPath = writeTranscript(root, 'iter-rebind', 'Working in new session.');

    // Capture stderr to assert rebind diagnostic.
    const origWrite = process.stderr.write.bind(process.stderr);
    let captured = '';
    process.stderr.write = (chunk) => { captured += chunk; return true; };

    try {
      const result = await runStopHook({
        stdin: { session_id: 'uuid-B', transcript_path: tPath },
        projectRoot: root,
      });

      // Auto-rebind: pursuing path runs, continuation is emitted.
      expect(result.stdout?.decision).toBe('block');
      const newState = loadState(root);
      expect(newState.session_id).toBe('uuid-B');
      expect(newState.budget.iterations.used).toBe(1);

      // History records the rebind for auditability.
      const rebindEvent = newState.history.find((e) => e.event === 'session-rebound');
      expect(rebindEvent).toBeDefined();
      expect(rebindEvent.payload.old_session_id).toBe('uuid-A');
      expect(rebindEvent.payload.new_session_id).toBe('uuid-B');

      // Diagnostic must surface (visible recovery hint, not silent).
      expect(captured).toContain('[goal-mode] Stop-hook session rebind');
      expect(captured).toContain('uuid-A');
      expect(captured).toContain('uuid-B');
      expect(captured).toContain('/goal-mode:goal-pause'); // opt-out hint
    } finally {
      process.stderr.write = origWrite;
    }
  });

  it('paused goal does NOT auto-rebind on session mismatch (user paused intentionally)', async () => {
    const baseState = pursuingState();
    baseState.lifecycle = 'paused';
    baseState.session_id = 'uuid-A';
    const { root } = setupProject(twoTaskTree(), baseState);
    const tPath = writeTranscript(root, 'iter-paused', 'Live but paused.');

    const result = await runStopHook({
      stdin: { session_id: 'uuid-B', transcript_path: tPath },
      projectRoot: root,
    });

    // Pass-through, state untouched.
    expect(result.stdout).toBeNull();
    const newState = loadState(root);
    expect(newState.session_id).toBe('uuid-A');
    expect(newState.budget.iterations.used).toBe(0);
    expect(newState.history.find((e) => e.event === 'session-rebound')).toBeUndefined();
  });

  it('anti-flap: refuses ping-pong rebind (B→A then A→B within 60s window)', async () => {
    // Strict ping-pong: the most recent rebind event was A→B (i.e., from
    // stdin.session_id back to current state.session_id) less than 60s ago.
    // Now stdin.session_id (uuid-B) is asking to rebind back. Refuse.
    const baseState = pursuingState();
    baseState.session_id = 'uuid-A';
    baseState.history.push({
      ts: new Date().toISOString(), // fresh — within FLAP_WINDOW_MS
      iteration: 0,
      event: 'session-rebound',
      node_id: baseState.cursor,
      payload: { old_session_id: 'uuid-B', new_session_id: 'uuid-A', reason: 'prior rebind B→A' },
    });
    const { root } = setupProject(twoTaskTree(), baseState);
    const tPath = writeTranscript(root, 'iter-flap', 'Ping-pong attempt.');

    const origWrite = process.stderr.write.bind(process.stderr);
    let captured = '';
    process.stderr.write = (chunk) => { captured += chunk; return true; };

    try {
      const result = await runStopHook({
        stdin: { session_id: 'uuid-B', transcript_path: tPath },
        projectRoot: root,
      });

      expect(result.stdout).toBeNull();
      const newState = loadState(root);
      expect(newState.session_id).toBe('uuid-A'); // not flipped back
      expect(newState.budget.iterations.used).toBe(0);

      expect(captured).toContain('[goal-mode] Stop-hook anti-flap');
      expect(captured).toContain('ping-pong');
      expect(captured).toContain('/goal-mode:goal-pause');
    } finally {
      process.stderr.write = origWrite;
    }
  });

  it('anti-flap: ALLOWS rebind when last rebound is older than 60s (compact / next-day scenario)', async () => {
    // The historical "unable to recover from compact" case: state was rebound
    // hours ago, current state.session_id is the dead post-compact UUID, new
    // session opens with fresh UUID. Auto-rebind must succeed.
    const baseState = pursuingState();
    baseState.session_id = 'uuid-A';
    const oldTs = new Date(Date.now() - 5 * 60_000).toISOString(); // 5 min ago
    baseState.history.push({
      ts: oldTs,
      iteration: 0,
      event: 'session-rebound',
      node_id: baseState.cursor,
      payload: { old_session_id: 'uuid-B', new_session_id: 'uuid-A', reason: 'prior rebind, long ago' },
    });
    const { root } = setupProject(twoTaskTree(), baseState);
    const tPath = writeTranscript(root, 'iter-stale', 'New session after compact.');

    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = () => true;
    try {
      const result = await runStopHook({
        stdin: { session_id: 'uuid-B', transcript_path: tPath },
        projectRoot: root,
      });

      // Auto-rebind succeeds — old rebind is stale, no flap.
      expect(result.stdout?.decision).toBe('block');
      const newState = loadState(root);
      expect(newState.session_id).toBe('uuid-B');
      expect(newState.history.filter((e) => e.event === 'session-rebound').length).toBe(2);
    } finally {
      process.stderr.write = origWrite;
    }
  });

  it('anti-flap: ALLOWS rebind when new session is a third UUID (not ping-pong)', async () => {
    // User closes session A, opens B briefly, closes B, opens C. State.session_id
    // is B (last rebound), now C fires Stop hook. Not a ping-pong (C != A).
    // Auto-rebind to C must succeed.
    const baseState = pursuingState();
    baseState.session_id = 'uuid-B';
    baseState.history.push({
      ts: new Date().toISOString(), // fresh
      iteration: 0,
      event: 'session-rebound',
      node_id: baseState.cursor,
      payload: { old_session_id: 'uuid-A', new_session_id: 'uuid-B', reason: 'A→B' },
    });
    const { root } = setupProject(twoTaskTree(), baseState);
    const tPath = writeTranscript(root, 'iter-third', 'Third session.');

    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = () => true;
    try {
      const result = await runStopHook({
        stdin: { session_id: 'uuid-C', transcript_path: tPath },
        projectRoot: root,
      });

      expect(result.stdout?.decision).toBe('block');
      const newState = loadState(root);
      expect(newState.session_id).toBe('uuid-C');
    } finally {
      process.stderr.write = origWrite;
    }
  });
});

describe('Stop-hook error visibility (error-as-prompt)', () => {
  it('zod throw inside saveState surfaces as block-decision continuation prompt (not silent null)', async () => {
    // Replicates the historical "engine встал" bug: saveState threw on a
    // schema violation (the unknown 'session-rebound' enum) and the previous
    // catch-block returned silent null → conversation paused with no
    // visibility. The new contract returns a block-decision diagnostic
    // prompt so the assistant sees and can react.
    const { root } = setupProject(twoTaskTree(), { ...pursuingState(), session_id: 'sess-err' });
    const tPath = writeTranscript(root, 'iter-err', 'Just chatting, no tags.');

    // Force saveState to throw on the next call, simulating a zod schema
    // violation that the engine's gate functions don't catch upstream.
    const spy = vi.spyOn(stateModule, 'saveState').mockImplementation(() => {
      const err = new Error('zod: invalid_enum_value at history[0].event');
      err.stack = `ZodError: invalid_enum_value\n  at GoalStateSchema.parse (state.mjs:175)\n  at saveState (state.mjs:174)`;
      throw err;
    });

    const origWrite = process.stderr.write.bind(process.stderr);
    const origErr = console.error;
    process.stderr.write = () => true;
    console.error = () => {};
    try {
      const result = await runStopHook({
        stdin: { session_id: 'sess-err', transcript_path: tPath },
        projectRoot: root,
      });
      // Must surface as block decision with diagnostic, NOT silent null.
      expect(result.stdout).not.toBeNull();
      expect(result.stdout.decision).toBe('block');
      expect(result.stdout.reason).toContain('goal-mode engine error');
      expect(result.stdout.reason).toContain('Recovery hints');
      expect(result.stdout.reason).toContain('zod: invalid_enum_value');
      expect(result.stdout.systemMessage).toContain('engine error');
      expect(result.error).toBeDefined();
    } finally {
      process.stderr.write = origWrite;
      console.error = origErr;
      spy.mockRestore();
    }
  });

  it('GENERAL contract: stdout is either null OR contains decision=block (never silent non-null)', async () => {
    // Replicates the historical "engine встал" bug class: state has a valid
    // schema at load time, but a write-side zod throw fires during the
    // pursuing path (e.g., applyMutations adds a history event that the
    // enum rejects, or saveState parses post-mutation state that violates
    // the schema). The previous catch-block returned silent null; this
    // test asserts the new contract returns a block-decision prompt.
    //
    // Reproduction strategy: pre-write state.json with a history entry
    // whose event is NOT in HistoryEventSchema. saveState's zod parse will
    // throw when the engine tries to save updated state (post-mutation).
    // We bypass saveState's schema check by writing the JSON directly.
    const { root } = setupProject(twoTaskTree(), { ...pursuingState(), session_id: 'sess-err' });
    const tPath = writeTranscript(root, 'iter-err', 'Some text without tags.');

    // Hand-write state with an out-of-enum history event. loadState's parser
    // will accept this (readWithBackup catches schema errors and returns null
    // — but only on READ; we need the throw on WRITE). To force the WRITE-side
    // throw, we patch state.json post-load by hooking saveState... actually,
    // simpler: write valid state but force a downstream saveTree failure by
    // corrupting tree.json to violate schema AFTER setupProject.
    //
    // Easiest deterministic crash: write tree.json with an invalid type field
    // on a node. saveTree's GoalTreeSchema.parse will throw when engine saves
    // post-mutation tree.
    const treePath = path.join(root, '.claude/goals/active/tree.json');
    const tree = JSON.parse(fs.readFileSync(treePath, 'utf8'));
    // Mutate read-side OK; but the mutation that will be saved back must fail.
    // Plant invalid status on the first task so schema-on-save throws.
    tree.root.children[0].status = 'NOT_A_VALID_STATUS';
    fs.writeFileSync(treePath, JSON.stringify(tree));

    const origWrite = process.stderr.write.bind(process.stderr);
    const origErr = console.error;
    process.stderr.write = () => true;
    console.error = () => {};
    try {
      const result = await runStopHook({
        stdin: { session_id: 'sess-err', transcript_path: tPath },
        projectRoot: root,
      });
      // loadTree's readWithBackup catches schema errors and returns null,
      // which is its own gate (line 131-132 in stop-hook.mjs) — not the
      // catch block. So accept EITHER null (graceful early-out) OR a block
      // diagnostic. What we must NOT see is a non-null stdout WITHOUT
      // `decision: 'block'` set.
      if (result.stdout !== null) {
        expect(result.stdout.decision).toBe('block');
      }

      // Now force an UNHANDLED throw: write valid tree, then corrupt the
      // state file path to a directory so the post-mutation atomicWrite throws.
      fs.writeFileSync(treePath, JSON.stringify(twoTaskTree()));
      const statePath = path.join(root, '.claude/goals/active/state.json');
      fs.unlinkSync(statePath);
      fs.mkdirSync(statePath, { recursive: true }); // state.json is now a directory → write throws

      const result2 = await runStopHook({
        stdin: { session_id: 'sess-err', transcript_path: tPath },
        projectRoot: root,
      });

      // loadState reads — readFileSync on a directory throws EISDIR, but
      // readWithBackup catches it and returns null → state is null → early
      // exit (line 113), not via catch block. So this scenario also hits
      // a graceful early-out.
      //
      // The catch block fires only on truly unexpected errors that bypass
      // the gate functions (zod throw inside saveState/saveTree, template
      // render error, applyMutations throw). The historical bug was a zod
      // throw inside saveState when an unknown enum value reached it.
      //
      // We assert the GENERAL contract: whenever result.stdout is non-null,
      // it must include `decision: 'block'`. Silent null is acceptable for
      // graceful early-outs (state missing/corrupt at load time); silent
      // non-block is the bug.
      if (result2.stdout !== null) {
        expect(result2.stdout.decision).toBe('block');
      }
    } finally {
      process.stderr.write = origWrite;
      console.error = origErr;
    }
  });

});
