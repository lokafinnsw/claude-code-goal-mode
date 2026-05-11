/**
 * v2.0.4 regression suite — the `awaiting-manual-approval` lifecycle gate.
 *
 * Closes the "Не лезу loop" bug user-reported 2026-05-11:
 *   - pre-v2.0.4: escape-hatch verdict marked cursor `blocked` but left
 *     lifecycle=pursuing, so Stop hook kept firing continuation-blocked.md
 *     every turn. The agent emitted <task-status>blocked</task-status>
 *     repeatedly (since it can't fix an environmental issue from code),
 *     ticking review_attempts toward the 3-strike unmet threshold. Goal
 *     terminated `unmet` purely from environmental cause.
 *
 * v2.0.4 fix:
 *   - apply-mutations transitions state.lifecycle to `awaiting-manual-approval`
 *     in the same turn as the escape-hatch + cursor-blocked mutation.
 *   - Stop hook renders continuation-blocked.md ONCE on the transition
 *     tick (so user sees recovery instructions), then on subsequent ticks
 *     returns null (the existing `lifecycle !== 'pursuing'` gate fires).
 *   - manualApprove accepts both review-pending (standard) and
 *     blocked+awaiting-manual-approval (escape-hatch) entry points; on
 *     success restores lifecycle to `pursuing` and advances cursor.
 *   - SessionStart hook surfaces the awaiting state with recovery hints
 *     when user opens a new session.
 *   - Doctor reports it as a warn with action.
 *   - /goal-resume rejects with a helpful message pointing at /goal-approve.
 *   - /goal-abandon accepts it (terminal-but-recoverable can still be
 *     manually killed).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runStopHook } from '../engine/stop-hook.mjs';
import { runSessionStartHook } from '../engine/session-start-hook.mjs';
import { applyMutations } from '../engine/apply-mutations.mjs';
import { manualApprove } from '../engine/manual-approve.mjs';
import { resumeGoal, pauseGoal, abandonGoal } from '../engine/lifecycle-commands.mjs';
import { checkAwaitingManualApproval } from '../engine/doctor.mjs';
import { activeDir, statePath, treePath, notesPath } from '../engine/paths.mjs';
import { saveState, saveTree, loadState } from '../engine/state.mjs';

const TS = '2026-05-11T22:00:00.000Z';

function mkRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'v204-amaa-'));
}

function mkTree(taskId = 't', review = ['aaa-art-director']) {
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
          id: taskId, type: 'task', title: 't', goal: 'tg',
          acceptance_criteria: ['c0'],
          review,
          validate: null, work_front: null,
          status: 'review-pending',
          evidence: [{ ts: TS, iteration: 1, criterion_index: 0, file: 'a', line: null, commit: null, command: null, exit_code: null, note: 'n' }],
          blocker_reason: null,
          review_attempts: 0,
          notes: [],
          children: [],
        },
        {
          id: 'sprint-1.task-next', type: 'task', title: 'next', goal: 'tg',
          acceptance_criteria: ['c0'],
          review: [], validate: null, work_front: null,
          status: 'pending',
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

function mkState(cursor = 't') {
  return {
    schema_version: 2,
    goal_id: 'g',
    lifecycle: 'pursuing',
    cursor,
    budget: {
      iterations: { used: 5, max: 100 },
      tokens: { used: 0, max: 0 },
      // Use NOW as wallclock start with a long max so the test doesn't
      // race the budget-limit check (which fires on wallclock_used >=
      // wallclock_max_seconds).
      wallclock: { started_at: new Date().toISOString(), max_seconds: 30 * 86400 },
    },
    session_id: 's',
    started_at: new Date().toISOString(),
    paused_at: null,
    ended_at: null,
    ended_reason: null,
    history: [],
  };
}

function setupProject(state, tree) {
  const root = mkRoot();
  fs.mkdirSync(activeDir(root), { recursive: true });
  saveTree(root, tree);
  saveState(root, state);
  fs.writeFileSync(notesPath(root), '');
  return root;
}

function writeTranscript(dir) {
  const tp = path.join(dir, 'transcript.jsonl');
  fs.writeFileSync(tp, '');
  return tp;
}

describe('v2.0.4: apply-mutations transitions lifecycle on escape-hatch', () => {
  it('sets state.lifecycle to awaiting-manual-approval when escape-hatch fires', () => {
    const tree = mkTree();
    const state = mkState();
    const tags = [
      { kind: 'audit-verdict', agent: 'aaa-art-director', status: 'REVISE', text: 'unavailable; user must run /goal-approve' },
    ];
    const result = applyMutations(tree, state, tags, TS, { scannedAgents: new Set() });
    expect(result.state.lifecycle).toBe('awaiting-manual-approval');
  });

  it('emits a lifecycle-changed history event with from/to/unavailable_reviewers', () => {
    const tree = mkTree();
    const state = mkState();
    const tags = [
      { kind: 'audit-verdict', agent: 'aaa-art-director', status: 'REVISE', text: 'unavailable' },
    ];
    const { history } = applyMutations(tree, state, tags, TS, { scannedAgents: new Set() });
    const transition = history.find((h) => h.event === 'lifecycle-changed');
    expect(transition).toBeDefined();
    expect(transition.payload.from).toBe('pursuing');
    expect(transition.payload.to).toBe('awaiting-manual-approval');
    expect(transition.payload.unavailable_reviewers).toEqual(['aaa-art-director']);
  });

  it('does NOT transition lifecycle when non-escape-hatch verdict is fabricated', () => {
    const tree = mkTree();
    const state = mkState();
    const tags = [
      { kind: 'audit-verdict', agent: 'aaa-art-director', status: 'GO', text: 'looks fine' },
    ];
    const result = applyMutations(tree, state, tags, TS, { scannedAgents: new Set() });
    expect(result.state.lifecycle).toBe('pursuing');
  });
});

describe('v2.0.4: Stop hook suppression after transition', () => {
  it('renders continuation-blocked.md ONCE on the transition tick (user sees recovery info)', async () => {
    const tree = mkTree();
    const state = mkState();
    const root = setupProject(state, tree);
    const transcript = writeTranscript(root);

    // Simulate the agent emitting an escape-hatch verdict by writing it as
    // the last assistant block in the transcript JSONL.
    fs.writeFileSync(
      transcript,
      JSON.stringify({
        timestamp: TS,
        message: {
          role: 'assistant',
          content: [{
            type: 'text',
            text: '<audit-verdict agent="aaa-art-director" status="REVISE">unavailable; user must run /goal-approve</audit-verdict>',
          }],
        },
      }) + '\n',
    );

    const result = await runStopHook({
      stdin: { session_id: 's', transcript_path: transcript },
      projectRoot: root,
    });

    expect(result.stdout).toBeTruthy();
    expect(result.stdout.decision).toBe('block');
    // The continuation-blocked.md rendering includes the recovery section:
    expect(result.stdout.reason).toMatch(/goal-mode:goal-approve/);
    // And lifecycle is now awaiting-manual-approval.
    const after = loadState(root);
    expect(after.lifecycle).toBe('awaiting-manual-approval');
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('returns null stdout on subsequent ticks (no spam loop)', async () => {
    const tree = mkTree();
    const state = mkState();
    state.lifecycle = 'awaiting-manual-approval'; // already transitioned
    tree.root.children[0].status = 'blocked';
    tree.root.children[0].blocker_reason = 'reviewer agent(s) unavailable in this environment: aaa-art-director.';
    const root = setupProject(state, tree);
    const transcript = writeTranscript(root);

    const result = await runStopHook({
      stdin: { session_id: 's', transcript_path: transcript },
      projectRoot: root,
    });
    expect(result.stdout).toBeNull();
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('v2.0.4: manualApprove accepts awaiting-manual-approval', () => {
  it('approves a blocked+awaiting-approval cursor and restores lifecycle=pursuing', () => {
    const tree = mkTree();
    tree.root.children[0].status = 'blocked';
    tree.root.children[0].blocker_reason = 'reviewer agent(s) unavailable in this environment: aaa-art-director.';
    const state = mkState();
    state.lifecycle = 'awaiting-manual-approval';
    const root = setupProject(state, tree);

    const result = manualApprove(root, { reason: 'user override after escape-hatch' });
    expect(result.ok).toBe(true);
    const after = loadState(root);
    expect(after.lifecycle).toBe('pursuing');
    // Cursor advanced to next pending task.
    expect(after.cursor).toBe('sprint-1.task-next');
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('clears stale blocker_reason on the approved node', () => {
    const tree = mkTree();
    tree.root.children[0].status = 'blocked';
    tree.root.children[0].blocker_reason = 'reviewer agent(s) unavailable in this environment: aaa-art-director.';
    const state = mkState();
    state.lifecycle = 'awaiting-manual-approval';
    const root = setupProject(state, tree);

    manualApprove(root, {});
    const reloaded = JSON.parse(fs.readFileSync(treePath(root), 'utf8'));
    // tree.root.children[0] is the approved node; blocker_reason cleared.
    expect(reloaded.root.children[0].status).toBe('achieved');
    expect(reloaded.root.children[0].blocker_reason).toBeNull();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('appends a lifecycle-changed history entry to record the transition', () => {
    const tree = mkTree();
    tree.root.children[0].status = 'blocked';
    const state = mkState();
    state.lifecycle = 'awaiting-manual-approval';
    const root = setupProject(state, tree);

    manualApprove(root, {});
    const after = loadState(root);
    const transition = [...after.history].reverse().find((h) =>
      h.event === 'lifecycle-changed'
      && h.payload?.from === 'awaiting-manual-approval'
      && h.payload?.to === 'pursuing',
    );
    expect(transition).toBeDefined();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('still rejects unrelated non-pursuing lifecycles', () => {
    const tree = mkTree();
    const state = mkState();
    state.lifecycle = 'paused';
    const root = setupProject(state, tree);
    const result = manualApprove(root, {});
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/lifecycle=paused/);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('still rejects pursuing+non-review-pending+non-blocked cursors', () => {
    const tree = mkTree();
    tree.root.children[0].status = 'pursuing'; // not review-pending, not blocked
    const state = mkState();
    const root = setupProject(state, tree);
    const result = manualApprove(root, {});
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not.*review-pending/i);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('v2.0.4: SessionStart hook surfaces the awaiting state', () => {
  it('emits additionalContext when lifecycle is awaiting-manual-approval', async () => {
    const tree = mkTree();
    tree.root.children[0].status = 'blocked';
    const state = mkState();
    state.lifecycle = 'awaiting-manual-approval';
    const root = setupProject(state, tree);

    const result = await runSessionStartHook({ stdin: { session_id: 's' }, projectRoot: root });
    expect(result.stdout).toBeTruthy();
    expect(result.stdout.hookSpecificOutput.additionalContext).toMatch(/waiting for manual approval/i);
    expect(result.stdout.hookSpecificOutput.additionalContext).toMatch(/goal-approve t/);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('returns null when goal is in non-awaiting non-pursuing lifecycle', async () => {
    const tree = mkTree();
    const state = mkState();
    state.lifecycle = 'paused';
    const root = setupProject(state, tree);
    const result = await runSessionStartHook({ stdin: { session_id: 's' }, projectRoot: root });
    expect(result.stdout).toBeNull();
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('v2.0.4: lifecycle commands handle awaiting-manual-approval', () => {
  it('/goal-resume rejects with /goal-approve hint', () => {
    const tree = mkTree();
    const state = mkState();
    state.lifecycle = 'awaiting-manual-approval';
    const root = setupProject(state, tree);
    const result = resumeGoal(root);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/goal-approve/);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('/goal-abandon accepts awaiting-manual-approval (terminal-but-recoverable can still be killed)', () => {
    const tree = mkTree();
    const state = mkState();
    state.lifecycle = 'awaiting-manual-approval';
    const root = setupProject(state, tree);
    const result = abandonGoal(root, { reason: 'no longer needed' });
    expect(result.ok).toBe(true);
    const after = loadState(root);
    expect(after.lifecycle).toBe('unmet');
    expect(after.ended_reason).toBe('no longer needed');
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('/goal-pause rejects awaiting-manual-approval (only pursuing is pauseable)', () => {
    const tree = mkTree();
    const state = mkState();
    state.lifecycle = 'awaiting-manual-approval';
    const root = setupProject(state, tree);
    const result = pauseGoal(root);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/lifecycle=awaiting-manual-approval/);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('v2.0.4: doctor checkAwaitingManualApproval', () => {
  it('returns warn with action when lifecycle is awaiting-manual-approval', () => {
    const tree = mkTree();
    const state = mkState();
    state.lifecycle = 'awaiting-manual-approval';
    state.history = [
      { ts: TS, iteration: 5, event: 'lifecycle-changed', node_id: 't', payload: { from: 'pursuing', to: 'awaiting-manual-approval', reason: 'escape-hatch', unavailable_reviewers: ['aaa-art-director'] } },
    ];
    const root = setupProject(state, tree);
    const result = checkAwaitingManualApproval(root);
    expect(result.status).toBe('warn');
    expect(result.message).toMatch(/aaa-art-director/);
    expect(result.fix).toMatch(/goal-approve t/);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('returns ok when goal is not in awaiting-manual-approval', () => {
    const tree = mkTree();
    const state = mkState();
    const root = setupProject(state, tree);
    const result = checkAwaitingManualApproval(root);
    expect(result.status).toBe('ok');
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('returns ok when no goal is active', () => {
    const root = mkRoot();
    const result = checkAwaitingManualApproval(root);
    expect(result.status).toBe('ok');
    expect(result.message).toMatch(/no goal active/);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('v2.0.4: end-to-end flow — no Не-лезу loop', () => {
  it('escape-hatch → ONE prompt → silent until /goal-approve → resume cursor advance', async () => {
    const tree = mkTree();
    const state = mkState();
    const root = setupProject(state, tree);
    const transcript = writeTranscript(root);

    // Tick 1: agent emits escape-hatch verdict.
    fs.writeFileSync(
      transcript,
      JSON.stringify({
        timestamp: TS,
        message: {
          role: 'assistant',
          content: [{
            type: 'text',
            text: '<audit-verdict agent="aaa-art-director" status="REVISE">unavailable; user must run /goal-approve</audit-verdict>',
          }],
        },
      }) + '\n',
    );
    const tick1 = await runStopHook({
      stdin: { session_id: 's', transcript_path: transcript },
      projectRoot: root,
    });
    expect(tick1.stdout).toBeTruthy(); // user sees recovery prompt once
    expect(tick1.stdout.reason).toMatch(/goal-approve/);

    // Tick 2-4: silent suppression (the pre-v2.0.4 "Не лезу" loop is gone).
    for (let i = 0; i < 3; i += 1) {
      // Re-fire the same transcript (simulates agent emitting more text).
      fs.appendFileSync(
        transcript,
        JSON.stringify({
          timestamp: TS,
          message: { role: 'assistant', content: [{ type: 'text', text: 'не лезу' }] },
        }) + '\n',
      );
      const tick = await runStopHook({
        stdin: { session_id: 's', transcript_path: transcript },
        projectRoot: root,
      });
      expect(tick.stdout).toBeNull();
    }

    // User runs /goal-approve.
    const approveResult = manualApprove(root, { reason: 'user override' });
    expect(approveResult.ok).toBe(true);

    // Tick after approval: regular continuation prompt for next task.
    const tick5 = await runStopHook({
      stdin: { session_id: 's', transcript_path: transcript },
      projectRoot: root,
    });
    expect(tick5.stdout).toBeTruthy();
    expect(tick5.stdout.systemMessage).toMatch(/🎯/); // normal pursuing
    const final = loadState(root);
    expect(final.lifecycle).toBe('pursuing');
    expect(final.cursor).toBe('sprint-1.task-next');

    fs.rmSync(root, { recursive: true, force: true });
  });
});
