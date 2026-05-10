import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { saveTree, saveState, loadState, loadTree } from '../engine/state.mjs';
import { runStopHook } from '../engine/stop-hook.mjs';
import { manualApprove } from '../engine/manual-approve.mjs';

function setupReviewableProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phase7-e2e-'));
  const tree = {
    schema_version: 1,
    goal_id: 'phase7-e2e',
    mission: 'Two-task with review[].',
    created_at: new Date().toISOString(),
    approved_at: new Date().toISOString(),
    root: {
      id: 's', type: 'sprint', title: 'Sprint 1', goal: 'Two tasks.',
      acceptance_criteria: [], review: [], validate: null,
      work_front: 'engine', status: 'pursuing',
      evidence: [], blocker_reason: null, review_attempts: 0, notes: [],
      children: [
        {
          id: 's.t1', type: 'task', title: 'Task 1',
          goal: 'Reviewable task 1.', acceptance_criteria: ['c0'],
          review: ['art-x'], validate: null,
          work_front: 'engine', status: 'pursuing',
          evidence: [], blocker_reason: null, review_attempts: 0, notes: [],
          children: [],
        },
        {
          id: 's.t2', type: 'task', title: 'Task 2',
          goal: 'Reviewable task 2.', acceptance_criteria: ['c0'],
          review: ['art-x'], validate: null,
          work_front: 'engine', status: 'pending',
          evidence: [], blocker_reason: null, review_attempts: 0, notes: [],
          children: [],
        },
      ],
    },
  };
  saveTree(root, tree);
  const state = {
    schema_version: 1,
    goal_id: 'phase7-e2e',
    lifecycle: 'pursuing',
    cursor: 's.t1',
    budget: {
      iterations: { used: 0, max: 100 },
      tokens: { used: 0, max: 1_000_000 },
      wallclock: { started_at: new Date().toISOString(), max_seconds: 14400 },
    },
    session_id: 'sess-phase7',
    started_at: new Date().toISOString(),
    paused_at: null, ended_at: null, ended_reason: null,
    history: [],
  };
  saveState(root, state);
  return root;
}

function writeTranscript(root, agentText) {
  const tPath = path.join(root, 'transcript.jsonl');
  fs.writeFileSync(tPath, JSON.stringify({
    message: { role: 'assistant', content: [{ type: 'text', text: agentText }] },
  }) + '\n');
  return tPath;
}

describe('Phase 7 E2E — audit gate', () => {
  it('Stop hook persists audit-verdict file when real reviewer GOes', async () => {
    const root = setupReviewableProject();
    const sessionId = 'sess-phase7';

    // Turn 1: agent finishes work, requests review.
    let tPath = writeTranscript(root,
      '<evidence file="t1.ts" criterion="0" note="done" />\n<task-status>achieved</task-status>\n<review-request agents="art-x" />');
    let result = await runStopHook({
      stdin: { session_id: sessionId, transcript_path: tPath },
      projectRoot: root,
    });
    expect(result.exit).toBe(0);

    // After turn 1: t1 is review-pending; no audit files yet.
    const auditDir = path.join(root, '.claude/goals/active/audits');
    expect(fs.existsSync(auditDir) && fs.readdirSync(auditDir).length > 0).toBe(false);

    // Turn 2: agent emits GO verdict.
    tPath = writeTranscript(root,
      '<audit-verdict agent="art-x" status="GO">looks good</audit-verdict>');
    result = await runStopHook({
      stdin: { session_id: sessionId, transcript_path: tPath },
      projectRoot: root,
    });

    // Audit file written.
    const files = fs.readdirSync(auditDir);
    expect(files.length).toBe(1);
    expect(files[0]).toContain('art-x');
    const body = JSON.parse(fs.readFileSync(path.join(auditDir, files[0]), 'utf8'));
    expect(body).toMatchObject({ agent: 'art-x', status: 'GO', text: 'looks good' });

    // Cursor advanced.
    const state = loadState(root);
    expect(state.cursor).toBe('s.t2');
  });

  it('Stop hook persists NOGO audits forensically (cursor stays put)', async () => {
    const root = setupReviewableProject();
    const sessionId = 'sess-phase7';

    // Turn 1: complete work + request review.
    let tPath = writeTranscript(root,
      '<evidence file="t1.ts" criterion="0" note="done" />\n<task-status>achieved</task-status>\n<review-request agents="art-x" />');
    await runStopHook({
      stdin: { session_id: sessionId, transcript_path: tPath },
      projectRoot: root,
    });

    // Turn 2: NOGO verdict.
    tPath = writeTranscript(root,
      '<audit-verdict agent="art-x" status="NOGO">contrast fails</audit-verdict>');
    await runStopHook({
      stdin: { session_id: sessionId, transcript_path: tPath },
      projectRoot: root,
    });

    const auditDir = path.join(root, '.claude/goals/active/audits');
    const files = fs.readdirSync(auditDir);
    expect(files.length).toBe(1);
    const body = JSON.parse(fs.readFileSync(path.join(auditDir, files[0]), 'utf8'));
    expect(body.status).toBe('NOGO');
    expect(body.text).toBe('contrast fails');

    // Cursor stays on s.t1 (review_attempts went up, but no advance).
    const state = loadState(root);
    expect(state.cursor).toBe('s.t1');
    const tree = loadTree(root);
    expect(tree.root.children[0].review_attempts).toBe(1);
  });

  it('manual /goal:approve writes audit + advances cursor end-to-end', async () => {
    const root = setupReviewableProject();
    const sessionId = 'sess-phase7';

    // Turn 1: agent finishes + requests review.
    const tPath = writeTranscript(root,
      '<evidence file="t1.ts" criterion="0" note="done" />\n<task-status>achieved</task-status>\n<review-request agents="art-x" />');
    await runStopHook({
      stdin: { session_id: sessionId, transcript_path: tPath },
      projectRoot: root,
    });

    let state = loadState(root);
    let tree = loadTree(root);
    expect(tree.root.children[0].status).toBe('review-pending');
    expect(state.cursor).toBe('s.t1');

    // User runs /goal:approve manually (e.g., reviewer 'art-x' is unavailable).
    const result = manualApprove(root, { reason: 'reviewer agent not installed' });
    expect(result.ok).toBe(true);
    expect(result.cursor).toBe('s.t2');

    state = loadState(root);
    tree = loadTree(root);
    expect(tree.root.children[0].status).toBe('achieved');
    expect(state.cursor).toBe('s.t2');

    // Audit file with manual: true is written.
    const auditDir = path.join(root, '.claude/goals/active/audits');
    const files = fs.readdirSync(auditDir);
    expect(files.length).toBe(1);
    expect(files[0]).toContain('manual');
    const body = JSON.parse(fs.readFileSync(path.join(auditDir, files[0]), 'utf8'));
    expect(body).toMatchObject({
      agent: 'manual',
      status: 'GO',
      text: 'reviewer agent not installed',
      manual: true,
    });
  });

  it('mixed flow: real NOGO → manual approve overrides → both audits persisted', async () => {
    const root = setupReviewableProject();
    const sessionId = 'sess-phase7';

    // Turn 1: complete + request review.
    let tPath = writeTranscript(root,
      '<evidence file="t1.ts" criterion="0" note="done" />\n<task-status>achieved</task-status>\n<review-request agents="art-x" />');
    await runStopHook({
      stdin: { session_id: sessionId, transcript_path: tPath },
      projectRoot: root,
    });

    // Turn 2: agent emits NOGO.
    tPath = writeTranscript(root,
      '<audit-verdict agent="art-x" status="NOGO">contrast fails</audit-verdict>');
    await runStopHook({
      stdin: { session_id: sessionId, transcript_path: tPath },
      projectRoot: root,
    });

    // Re-stage: user re-emits achieved + review-request to get back to review-pending.
    tPath = writeTranscript(root,
      '<evidence file="t1.ts" criterion="0" note="contrast fixed" />\n<task-status>achieved</task-status>\n<review-request agents="art-x" />');
    await runStopHook({
      stdin: { session_id: sessionId, transcript_path: tPath },
      projectRoot: root,
    });

    let tree = loadTree(root);
    expect(tree.root.children[0].status).toBe('review-pending');

    // User runs /goal:approve to override the prior NOGO and accept the fix.
    const result = manualApprove(root, { reason: 'fix verified manually' });
    expect(result.ok).toBe(true);

    // Audit dir contains 2 files: the NOGO + the manual GO.
    const auditDir = path.join(root, '.claude/goals/active/audits');
    const files = fs.readdirSync(auditDir).sort();
    expect(files.length).toBe(2);

    // One has agent=art-x status=NOGO; the other has agent=manual status=GO.
    const bodies = files.map(f => JSON.parse(fs.readFileSync(path.join(auditDir, f), 'utf8')));
    const agents = bodies.map(b => b.agent).sort();
    expect(agents).toEqual(['art-x', 'manual']);
    const statuses = bodies.map(b => b.status).sort();
    expect(statuses).toEqual(['GO', 'NOGO']);

    // Manual approve always advanced cursor.
    tree = loadTree(root);
    const state = loadState(root);
    expect(tree.root.children[0].status).toBe('achieved');
    expect(state.cursor).toBe('s.t2');
  });

  it('terminal achievement: manual approve on last task transitions lifecycle to achieved', async () => {
    const root = setupReviewableProject();
    const sessionId = 'sess-phase7';

    // Pre-stage: t1 already achieved, t2 in review-pending.
    const tree = loadTree(root);
    tree.root.children[0].status = 'achieved';
    tree.root.children[1].status = 'review-pending';
    tree.root.children[1].evidence = [
      { ts: '2026-05-09T01:00:00.000Z', iteration: 1, criterion_index: 0, file: 't2.ts', line: null, commit: null, command: null, exit_code: null, note: 'done' },
    ];
    saveTree(root, tree);
    const state = loadState(root);
    state.cursor = 's.t2';
    saveState(root, state);

    // Manual approve t2.
    const result = manualApprove(root, { reason: 'final approval' });
    expect(result.ok).toBe(true);

    const finalState = loadState(root);
    expect(finalState.lifecycle).toBe('achieved');
    expect(finalState.ended_reason).toMatch(/all tasks achieved.*manual approve/i);

    // Stop hook now silently exits on lifecycle != pursuing.
    const tPath = writeTranscript(root, 'should be ignored, goal achieved');
    const stopResult = await runStopHook({
      stdin: { session_id: sessionId, transcript_path: tPath },
      projectRoot: root,
    });
    expect(stopResult.stdout).toBeNull();
  });
});
