import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { saveTree, loadState, loadTree } from '../engine/state.mjs';
import { startGoal } from '../engine/start-goal.mjs';
import { runStopHook } from '../engine/stop-hook.mjs';
import { pauseGoal, resumeGoal, clearGoal, abandonGoal } from '../engine/lifecycle-commands.mjs';
import { renderStatus } from '../engine/render-status.mjs';

function makeApprovedTree() {
  return {
    schema_version: 1,
    goal_id: 'e2e-smoke',
    mission: 'Drive a 2-task goal end-to-end through the user lifecycle.',
    created_at: '2026-05-09T00:00:00.000Z',
    approved_at: '2026-05-09T00:00:00.000Z',
    root: {
      id: 's', type: 'sprint', title: 'Sprint 1', goal: 'Two tasks.',
      acceptance_criteria: [], review: [], validate: null,
      work_front: 'engine', status: 'pending',
      evidence: [], blocker_reason: null, review_attempts: 0, notes: [],
      children: [
        {
          id: 's.t1', type: 'task', title: 'Task 1',
          goal: 'First task.', acceptance_criteria: ['c0'],
          review: [], validate: null, work_front: 'engine', status: 'pending',
          evidence: [], blocker_reason: null, review_attempts: 0, notes: [],
          children: [],
        },
        {
          id: 's.t2', type: 'task', title: 'Task 2',
          goal: 'Second task.', acceptance_criteria: ['c0'],
          review: [], validate: null, work_front: 'engine', status: 'pending',
          evidence: [], blocker_reason: null, review_attempts: 0, notes: [],
          children: [],
        },
      ],
    },
  };
}

function setupProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phase5-e2e-'));
  saveTree(root, makeApprovedTree());
  return root;
}

function writeTranscript(root, agentText) {
  const tPath = path.join(root, 'transcript.jsonl');
  fs.writeFileSync(tPath, JSON.stringify({
    message: { role: 'assistant', content: [{ type: 'text', text: agentText }] },
  }) + '\n');
  return tPath;
}

describe('Phase 5 E2E smoke — full lifecycle journey', () => {
  it('happy path: start → drive 2 tasks via Stop hooks → status → achieved → clear', async () => {
    const root = setupProject();
    const sessionId = 'e2e-sess-1';

    // 1. Start the goal.
    const startResult = startGoal(root, {
      sessionId,
      maxIter: 50,
      tokenBudget: 1_000_000,
      timeBudgetSeconds: 7200,
    });
    expect(startResult.ok).toBe(true);
    expect(startResult.cursor).toBe('s.t1');

    let state = loadState(root);
    let tree = loadTree(root);
    expect(state.lifecycle).toBe('pursuing');
    expect(state.session_id).toBe(sessionId);

    // 2. /goal:status renders correctly post-start.
    const status1 = renderStatus(tree, state);
    expect(status1).toContain('lifecycle: pursuing');
    expect(status1).toContain('s.t1 ◀ cursor');
    expect(status1).toContain('Iterations:');

    // 3. First Stop-hook invocation: agent achieves t1.
    let tPath = writeTranscript(root,
      'Working on Task 1.\n<evidence file="t1.ts" criterion="0" note="implemented" />\n<task-status>achieved</task-status>');
    let result = await runStopHook({ stdin: { session_id: sessionId, transcript_path: tPath }, projectRoot: root });
    expect(result.exit).toBe(0);
    expect(result.stdout.systemMessage).toMatch(/🎯 s\.t2/);  // cursor advanced

    state = loadState(root);
    tree = loadTree(root);
    expect(state.cursor).toBe('s.t2');
    expect(state.budget.iterations.used).toBe(1);
    expect(tree.root.children[0].status).toBe('achieved');

    // 4. /goal:status mid-run shows the advance.
    const status2 = renderStatus(tree, state);
    expect(status2).toContain('s.t2 ◀ cursor');
    expect(status2).toContain('✅');  // t1 achieved

    // 5. Second Stop-hook invocation: agent achieves t2.
    tPath = writeTranscript(root,
      '<evidence file="t2.ts" criterion="0" note="done" />\n<task-status>achieved</task-status>');
    result = await runStopHook({ stdin: { session_id: sessionId, transcript_path: tPath }, projectRoot: root });
    expect(result.exit).toBe(0);
    expect(result.stdout.systemMessage).toBe('✅ goal achieved');

    state = loadState(root);
    tree = loadTree(root);
    expect(state.lifecycle).toBe('achieved');
    expect(state.budget.iterations.used).toBe(2);
    expect(tree.root.children[1].status).toBe('achieved');

    // 6. /goal:status post-completion.
    const status3 = renderStatus(tree, state);
    expect(status3).toContain('lifecycle: achieved');

    // 7. /goal:clear --archive: archive, then remove active dir.
    const clearResult = clearGoal(root, { archive: true });
    expect(clearResult.ok).toBe(true);
    expect(clearResult.archivedTo).toBeTruthy();
    expect(fs.existsSync(clearResult.archivedTo)).toBe(true);
    expect(fs.existsSync(path.join(root, '.claude/goals/active'))).toBe(false);

    // 8. Archive contains both tree.json and state.json.
    expect(fs.existsSync(path.join(clearResult.archivedTo, 'tree.json'))).toBe(true);
    expect(fs.existsSync(path.join(clearResult.archivedTo, 'state.json'))).toBe(true);

    // 9. After clear, startGoal can re-init successfully (write a fresh tree first since clear removed it).
    saveTree(root, makeApprovedTree());
    const restartResult = startGoal(root, { sessionId: 'e2e-sess-2', maxIter: 50, tokenBudget: 1_000_000, timeBudgetSeconds: 7200 });
    expect(restartResult.ok).toBe(true);
  });

  it('pause/resume cycle: start → run 1 iteration → pause → Stop hook is no-op → resume → continue', async () => {
    const root = setupProject();
    const sessionId = 'e2e-sess-pause';

    // 1. Start.
    startGoal(root, { sessionId, maxIter: 50, tokenBudget: 1_000_000, timeBudgetSeconds: 7200 });

    // 2. One iteration of work.
    let tPath = writeTranscript(root,
      '<evidence file="t1.ts" criterion="0" note="working" />\nstill in progress');
    let result = await runStopHook({ stdin: { session_id: sessionId, transcript_path: tPath }, projectRoot: root });
    expect(result.stdout.systemMessage).toMatch(/🎯 s\.t1/);  // still on t1

    let state = loadState(root);
    expect(state.budget.iterations.used).toBe(1);
    expect(state.lifecycle).toBe('pursuing');

    // 3. Pause.
    const pauseResult = pauseGoal(root);
    expect(pauseResult.ok).toBe(true);
    state = loadState(root);
    expect(state.lifecycle).toBe('paused');
    expect(state.paused_at).toBeTruthy();

    // 4. Stop hook fires while paused → silent no-op (no stdout).
    tPath = writeTranscript(root, 'this should be ignored while paused');
    result = await runStopHook({ stdin: { session_id: sessionId, transcript_path: tPath }, projectRoot: root });
    expect(result.exit).toBe(0);
    expect(result.stdout).toBeNull();

    // 5. Iteration counter is NOT incremented during pause (the orchestrator's lifecycle gate fires before increment).
    state = loadState(root);
    expect(state.budget.iterations.used).toBe(1);  // unchanged from before pause

    // 6. Resume.
    const resumeResult = resumeGoal(root);
    expect(resumeResult.ok).toBe(true);
    state = loadState(root);
    expect(state.lifecycle).toBe('pursuing');
    expect(state.paused_at).toBeNull();

    // 7. Stop hook fires post-resume → drives forward again.
    tPath = writeTranscript(root,
      '<evidence file="t1.ts" criterion="0" note="finished" />\n<task-status>achieved</task-status>');
    result = await runStopHook({ stdin: { session_id: sessionId, transcript_path: tPath }, projectRoot: root });
    expect(result.stdout.systemMessage).toMatch(/🎯 s\.t2/);  // advanced to t2

    state = loadState(root);
    expect(state.budget.iterations.used).toBe(2);  // incremented post-resume
    expect(state.cursor).toBe('s.t2');
  });

  it('abandon path: start → 1 iteration → abandon with reason → lifecycle unmet → Stop hook no-op', async () => {
    const root = setupProject();
    const sessionId = 'e2e-sess-abandon';

    // 1. Start.
    startGoal(root, { sessionId, maxIter: 50, tokenBudget: 1_000_000, timeBudgetSeconds: 7200 });

    // 2. One iteration.
    let tPath = writeTranscript(root, 'starting work');
    await runStopHook({ stdin: { session_id: sessionId, transcript_path: tPath }, projectRoot: root });

    // 3. Abandon with explicit reason.
    const abandonResult = abandonGoal(root, { reason: 'pivoting to a different approach' });
    expect(abandonResult.ok).toBe(true);

    let state = loadState(root);
    expect(state.lifecycle).toBe('unmet');
    expect(state.ended_reason).toBe('pivoting to a different approach');
    expect(state.ended_at).toBeTruthy();
    const lastEvent = state.history[state.history.length - 1];
    expect(lastEvent.event).toBe('unmet');
    expect(lastEvent.payload.reason).toBe('pivoting to a different approach');

    // 4. Stop hook fires post-abandon → silent no-op.
    tPath = writeTranscript(root, 'should be ignored');
    const result = await runStopHook({ stdin: { session_id: sessionId, transcript_path: tPath }, projectRoot: root });
    expect(result.exit).toBe(0);
    expect(result.stdout).toBeNull();

    // 5. /goal:status shows unmet.
    const tree = loadTree(root);
    state = loadState(root);
    const status = renderStatus(tree, state);
    expect(status).toContain('lifecycle: unmet');

    // 6. abandonGoal called twice → second call refuses (lifecycle gate).
    const second = abandonGoal(root, { reason: 'redundant' });
    expect(second.ok).toBe(false);
    expect(second.error).toMatch(/cannot abandon from lifecycle=unmet/);
  });
});
