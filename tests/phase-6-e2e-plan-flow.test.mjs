import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { saveTree, saveState, loadTree, loadState } from '../engine/state.mjs';
import { approvePlan } from '../engine/approve-plan-cli.mjs';
import { startGoal } from '../engine/start-goal.mjs';
import { runStopHook } from '../engine/stop-hook.mjs';

/**
 * Synthesize what `/goal:plan` would produce after Claude follows the
 * bootstrap prompt: a tree.json (with approved_at: null, all statuses
 * 'pending') and a draft state.json (with placeholder cursor/session_id).
 *
 * In production, Claude writes these via the Write tool after reading
 * prompts/plan-bootstrap.md. We synthesize them directly to test the
 * downstream chain.
 */
function simulateGoalPlanOutput(projectRoot) {
  const tree = {
    schema_version: 2,
    goal_id: 'e2e-plan-flow',
    mission: 'Two-task mission for Phase 6 → Phase 5 wiring proof.',
    created_at: new Date().toISOString(),
    approved_at: null,
    root: {
      id: 's', type: 'sprint', title: 'Sprint 1', goal: 'Two tasks.',
      acceptance_criteria: [], review: [], validate: null,
      work_front: 'engine', status: 'pending',
      evidence: [], blocker_reason: null, review_attempts: 0, notes: [],
      children: [
        {
          id: 's.t1', type: 'task', title: 'Task 1',
          goal: 'First task in the chain.', acceptance_criteria: ['c0'],
          review: [], validate: 'npm test',
          work_front: 'engine', status: 'pending',
          evidence: [], blocker_reason: null, review_attempts: 0, notes: [],
          children: [],
        },
        {
          id: 's.t2', type: 'task', title: 'Task 2',
          goal: 'Second task in the chain.', acceptance_criteria: ['c0'],
          review: [], validate: 'npm test',
          work_front: 'engine', status: 'pending',
          evidence: [], blocker_reason: null, review_attempts: 0, notes: [],
          children: [],
        },
      ],
    },
  };
  saveTree(projectRoot, tree);

  const state = {
    schema_version: 2,
    goal_id: 'e2e-plan-flow',
    lifecycle: 'draft',
    cursor: 'pending',
    budget: {
      iterations: { used: 0, max: 0 },
      tokens: { used: 0, max: 0 },
      wallclock: { started_at: new Date().toISOString(), max_seconds: 0 },
    },
    session_id: 'pending',
    started_at: null,
    paused_at: null,
    ended_at: null,
    ended_reason: null,
    history: [],
  };
  saveState(projectRoot, state);
}

function setupProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'phase6-e2e-'));
}

function writeTranscript(root, agentText) {
  const tPath = path.join(root, 'transcript.jsonl');
  fs.writeFileSync(tPath, JSON.stringify({
    message: { role: 'assistant', content: [{ type: 'text', text: agentText }] },
  }) + '\n');
  return tPath;
}

describe('Phase 6 → Phase 5 E2E plan flow', () => {
  it('happy path: /goal:plan output → /goal:approve-plan → /goal:start → first Stop hook drives', async () => {
    const root = setupProject();
    const sessionId = 'e2e-phase6-1';

    // Step 1: simulate /goal:plan writing tree.json + draft state.json.
    simulateGoalPlanOutput(root);

    let state = loadState(root);
    let tree = loadTree(root);
    expect(state.lifecycle).toBe('draft');
    expect(tree.approved_at).toBeNull();

    // Step 2: /goal:approve-plan validates and stamps approved.
    const approveResult = approvePlan(root, { availableReviewers: new Set() });
    expect(approveResult.ok).toBe(true);
    expect(approveResult.taskCount).toBe(2);

    state = loadState(root);
    tree = loadTree(root);
    expect(state.lifecycle).toBe('approved');
    expect(tree.approved_at).toBeTruthy();
    const approvedEvent = state.history[state.history.length - 1];
    expect(approvedEvent.event).toBe('plan-approved');

    // Step 3: /goal:start initializes triple budget + cursor + session_id.
    // Use --force because state.lifecycle === 'approved' (not pursuing) — but
    // startGoal's existing-state check refuses any existing state without force.
    const startResult = startGoal(root, {
      sessionId,
      maxIter: 50,
      tokenBudget: 1_000_000,
      timeBudgetSeconds: 7200,
      force: true,
    });
    expect(startResult.ok).toBe(true);
    expect(startResult.cursor).toBe('s.t1');

    state = loadState(root);
    expect(state.lifecycle).toBe('pursuing');
    expect(state.session_id).toBe(sessionId);
    expect(state.cursor).toBe('s.t1');

    // Step 4: First Stop hook drives forward — agent achieves t1.
    const tPath = writeTranscript(root,
      'Implementing Task 1.\n<evidence file="t1.ts" criterion="0" note="done" />\n<task-status>achieved</task-status>');
    const result = await runStopHook({
      stdin: { session_id: sessionId, transcript_path: tPath },
      projectRoot: root,
    });
    expect(result.exit).toBe(0);
    expect(result.stdout.systemMessage).toMatch(/🎯 s\.t2/);  // cursor advanced

    state = loadState(root);
    tree = loadTree(root);
    expect(state.cursor).toBe('s.t2');
    expect(tree.root.children[0].status).toBe('achieved');
    expect(state.budget.iterations.used).toBe(1);
  });

  it('approve-plan refuses if /goal:plan output had a placeholder in goal text', async () => {
    const root = setupProject();
    simulateGoalPlanOutput(root);

    // Corrupt the tree post-plan: insert a placeholder.
    const tree = loadTree(root);
    tree.root.children[0].goal = 'TODO: figure this out later';
    saveTree(root, tree);

    const result = approvePlan(root, { availableReviewers: new Set() });
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toMatch(/placeholder/i);

    // State preserved at draft; tree.approved_at still null.
    const state = loadState(root);
    expect(state.lifecycle).toBe('draft');
    const treeAfter = loadTree(root);
    expect(treeAfter.approved_at).toBeNull();
  });

  it('approve-plan emits warnings when reviewers unavailable but still approves', async () => {
    const root = setupProject();
    simulateGoalPlanOutput(root);

    // Add review[] to one task referencing reviewers not in availability set.
    const tree = loadTree(root);
    tree.root.children[0].review = ['art-reviewer-x', 'design-reviewer-y'];
    saveTree(root, tree);

    const result = approvePlan(root, { availableReviewers: new Set(['art-reviewer-x']) });
    expect(result.ok).toBe(true);
    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0]).toMatch(/design-reviewer-y/);
    expect(result.warnings[0]).not.toMatch(/art-reviewer-x/);

    const state = loadState(root);
    expect(state.lifecycle).toBe('approved');
  });

  it('start-goal refuses unapproved tree (Phase 6 → Phase 5 contract)', async () => {
    const root = setupProject();
    simulateGoalPlanOutput(root);  // tree.approved_at: null after this

    // Skip /goal:approve-plan and try to start directly.
    const result = startGoal(root, {
      sessionId: 'sess-x',
      maxIter: 50,
      tokenBudget: 1_000_000,
      timeBudgetSeconds: 7200,
      force: true,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not approved/i);

    // After approve-plan, start succeeds.
    approvePlan(root, { availableReviewers: new Set() });
    const result2 = startGoal(root, {
      sessionId: 'sess-x',
      maxIter: 50,
      tokenBudget: 1_000_000,
      timeBudgetSeconds: 7200,
      force: true,
    });
    expect(result2.ok).toBe(true);
  });
});
