import { describe, it, expect } from 'vitest';
import { runStopHook } from '../engine/stop-hook.mjs';
import { loadState, loadTree, saveState, saveTree } from '../engine/state.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function setupProject(tree, state, transcripts) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'goal-multi-'));
  saveTree(root, tree);
  saveState(root, state);
  return { root, transcripts };
}

function writeTranscript(root, name, agentText) {
  const tPath = path.join(root, `${name}.jsonl`);
  fs.writeFileSync(tPath, JSON.stringify({
    message: { role: 'assistant', content: [{ type: 'text', text: agentText }] },
  }) + '\n');
  return tPath;
}

function twoTaskTree() {
  return {
    schema_version: 1,
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
    schema_version: 1, goal_id: 'g', lifecycle: 'pursuing', cursor: 's.t1',
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
    expect(tree.root.children[1].status).toBe('pending');

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

    // Turn 2: NOGO verdict.
    const t2Path = writeTranscript(root, 'iter2',
      '<audit-verdict agent="art-x" status="NOGO">color contrast fails</audit-verdict>');
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

    // Turn 4: GO verdict.
    const t4Path = writeTranscript(root, 'iter4',
      '<audit-verdict agent="art-x" status="GO">looks good</audit-verdict>');
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
