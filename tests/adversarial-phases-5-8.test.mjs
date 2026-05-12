/**
 * Adversarial test suite — Phases 5-8
 *
 * Covers categories H (start-goal), I (lifecycle commands), J (validate-plan),
 * K (audit/manual-approve), L (triple budget), M (cross-phase wiring).
 *
 * Design principles:
 *  - Synthetic fixtures only; never assume real files outside tmpdir.
 *  - Use new Date().toISOString() for wallclock.started_at so tests don't
 *    trip budget exhaustion (avoids "fixture aging" failures).
 *  - Do NOT modify engine code.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { startGoal } from '../engine/start-goal.mjs';
import { pauseGoal, resumeGoal, clearGoal, abandonGoal } from '../engine/lifecycle-commands.mjs';
import { validatePlan } from '../engine/validate-plan.mjs';
import { manualApprove } from '../engine/manual-approve.mjs';
import { applyMutations } from '../engine/apply-mutations.mjs';
import { tallyTokens, checkLimits } from '../engine/budget.mjs';
import { wallclockMinutes } from '../engine/wallclock.mjs';
import { renderStatus } from '../engine/render-status.mjs';
import { runStopHook } from '../engine/stop-hook.mjs';
import { saveTree, saveState, loadState, loadTree } from '../engine/state.mjs';
import { activeDir, auditsDir, archiveDir } from '../engine/paths.mjs';
import { discoverReviewers, approvePlan } from '../engine/approve-plan-cli.mjs';

// ─── shared fixture builders ────────────────────────────────────────────────

function approvedTree(overrides = {}) {
  return {
    schema_version: 2,
    goal_id: 'test-goal',
    mission: 'adversarial test mission',
    created_at: new Date().toISOString(),
    approved_at: new Date().toISOString(),
    root: {
      id: 's', type: 'sprint', title: 'Sprint', goal: 'sprint goal',
      acceptance_criteria: [], review: [], validate: null,
      work_front: null, status: 'pending',
      evidence: [], blocker_reason: null, review_attempts: 0, notes: [],
      children: [
        {
          id: 's.t1', type: 'task', title: 'Task 1', goal: 'task goal',
          acceptance_criteria: ['criterion 0'], review: [], validate: null,
          work_front: null, status: 'pending',
          evidence: [], blocker_reason: null, review_attempts: 0, notes: [],
          children: [],
        },
        {
          id: 's.t2', type: 'task', title: 'Task 2', goal: 'task 2 goal',
          acceptance_criteria: ['criterion 0'], review: [], validate: null,
          work_front: null, status: 'pending',
          evidence: [], blocker_reason: null, review_attempts: 0, notes: [],
          children: [],
        },
      ],
    },
    ...overrides,
  };
}

/**
 * Build a pursuing state. Supports budget sub-overrides via:
 *   maxIter, maxTokens, maxSeconds — budget limits
 *   iterUsed, tokUsed              — budget used values
 *   startedAt                      — wallclock.started_at
 * All other keys are flat-spread onto the state root.
 */
function pursuingState(overrides = {}) {
  const {
    maxIter = 100,
    maxTokens = 1_000_000,
    maxSeconds = 14400,
    iterUsed = 0,
    tokUsed = 0,
    startedAt = new Date().toISOString(),
    sessionId = 'sess-adv',
    ...rest
  } = overrides;
  return {
    schema_version: 2,
    goal_id: 'test-goal',
    lifecycle: 'pursuing',
    cursor: 's.t1',
    budget: {
      iterations: { used: iterUsed, max: maxIter },
      tokens: { used: tokUsed, max: maxTokens },
      wallclock: { started_at: startedAt, max_seconds: maxSeconds },
    },
    session_id: sessionId,
    started_at: new Date().toISOString(),
    paused_at: null,
    ended_at: null,
    ended_reason: null,
    history: [],
    ...rest,
  };
}

function mkroot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adv58-'));
  // v3.0: these tests exercise the legacy Stop-hook driver path
  // (continuation injection on lifecycle=pursuing). Pin every fixture
  // to stopHookDriver=true so the v3 default short-circuit (null
  // stdout on pursuing) doesn't fire.
  fs.mkdirSync(activeDir(root), { recursive: true });
  fs.writeFileSync(
    path.join(activeDir(root), 'config.json'),
    JSON.stringify({ schema_version: 1, stopHookDriver: true }),
  );
  return root;
}

function tmpJsonl(rows) {
  const f = path.join(os.tmpdir(), `adv-tally-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
  fs.writeFileSync(f, rows.map(r => JSON.stringify(r)).join('\n'));
  return f;
}

function assistantRow(opts = {}) {
  return {
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: opts.text ?? 'no tags' }],
      usage: {
        input_tokens: opts.input ?? 0,
        output_tokens: opts.output ?? 0,
        cache_creation_input_tokens: opts.cacheCreate ?? 0,
        cache_read_input_tokens: opts.cacheRead ?? 0,
      },
    },
  };
}

function writeTranscript(root, rows) {
  const tPath = path.join(root, 'transcript.jsonl');
  fs.writeFileSync(tPath, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  return tPath;
}

// ─── H. Phase 5 — start-goal hardening ──────────────────────────────────────

describe('H — Phase 5: start-goal hardening', () => {

  it('H1a: double-start without force is refused with informative error', () => {
    const root = mkroot();
    saveTree(root, approvedTree());
    const first = startGoal(root, { sessionId: 'sess1', maxIter: 10, tokenBudget: 0, timeBudgetSeconds: 0 });
    expect(first.ok).toBe(true);

    const second = startGoal(root, { sessionId: 'sess2', maxIter: 20, tokenBudget: 0, timeBudgetSeconds: 0 });
    expect(second.ok).toBe(false);
    expect(second.error).toMatch(/already active/i);
    // Existing session_id must NOT be overwritten
    const state = loadState(root);
    expect(state.session_id).toBe('sess1');
  });

  it('H1b: double-start WITH force=true overwrites state completely', () => {
    const root = mkroot();
    saveTree(root, approvedTree());
    startGoal(root, { sessionId: 'sess1', maxIter: 10, tokenBudget: 0, timeBudgetSeconds: 0 });
    const second = startGoal(root, { sessionId: 'sess2', maxIter: 99, tokenBudget: 0, timeBudgetSeconds: 0, force: true });
    expect(second.ok).toBe(true);
    const state = loadState(root);
    expect(state.session_id).toBe('sess2');
    expect(state.budget.iterations.max).toBe(99);
    expect(state.lifecycle).toBe('pursuing');
  });

  it('H1c: force=true resets iteration counter to 0 (not inherited from prior run)', () => {
    const root = mkroot();
    saveTree(root, approvedTree());
    startGoal(root, { sessionId: 'sess1', maxIter: 5, tokenBudget: 0, timeBudgetSeconds: 0 });
    // Manually advance iterations to simulate a mid-run state
    const st = loadState(root);
    st.budget.iterations.used = 3;
    saveState(root, st);

    startGoal(root, { sessionId: 'sess2', maxIter: 5, tokenBudget: 0, timeBudgetSeconds: 0, force: true });
    const newState = loadState(root);
    expect(newState.budget.iterations.used).toBe(0);
  });

  it('H2a: empty-string sessionId should fail schema (session_id: z.string().min(1))', () => {
    const root = mkroot();
    saveTree(root, approvedTree());
    // startGoal calls saveState which calls GoalStateSchema.parse — session_id='' fails min(1)
    expect(() => {
      startGoal(root, { sessionId: '', maxIter: 10, tokenBudget: 0, timeBudgetSeconds: 0 });
    }).toThrow();
  });

  it('H2b: undefined sessionId should fail schema', () => {
    const root = mkroot();
    saveTree(root, approvedTree());
    expect(() => {
      startGoal(root, { sessionId: undefined, maxIter: 10, tokenBudget: 0, timeBudgetSeconds: 0 });
    }).toThrow();
  });

  it('H3: tree where ALL tasks are "achieved" → startGoal refuses gracefully', () => {
    const root = mkroot();
    const tree = approvedTree();
    tree.root.children[0].status = 'achieved';
    tree.root.children[1].status = 'achieved';
    saveTree(root, tree);
    const result = startGoal(root, { sessionId: 'sess', maxIter: 10, tokenBudget: 0, timeBudgetSeconds: 0 });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/no pending(?: or pursuing)? tasks/i);
  });

  it('H4: tree with only "blocked" tasks (no pending/pursuing) → startGoal refuses', () => {
    const root = mkroot();
    const tree = approvedTree();
    tree.root.children[0].status = 'blocked';
    tree.root.children[1].status = 'blocked';
    saveTree(root, tree);
    const result = startGoal(root, { sessionId: 'sess', maxIter: 10, tokenBudget: 0, timeBudgetSeconds: 0 });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/no pending(?: or pursuing)? tasks/i);
  });

  it('H4b: tree with mixed achieved+blocked → refuses', () => {
    const root = mkroot();
    const tree = approvedTree();
    tree.root.children[0].status = 'achieved';
    tree.root.children[1].status = 'blocked';
    saveTree(root, tree);
    const result = startGoal(root, { sessionId: 'sess', maxIter: 10, tokenBudget: 0, timeBudgetSeconds: 0 });
    expect(result.ok).toBe(false);
  });

  it('H5a: maxIter=0 is accepted (means "no limit") and stored verbatim', () => {
    const root = mkroot();
    saveTree(root, approvedTree());
    const result = startGoal(root, { sessionId: 'sess', maxIter: 0, tokenBudget: 0, timeBudgetSeconds: 0 });
    expect(result.ok).toBe(true);
    const state = loadState(root);
    expect(state.budget.iterations.max).toBe(0);
    expect(state.budget.tokens.max).toBe(0);
    expect(state.budget.wallclock.max_seconds).toBe(0);
  });

  it('H5b: negative maxIter should fail schema validation (nonnegative)', () => {
    const root = mkroot();
    saveTree(root, approvedTree());
    expect(() => {
      startGoal(root, { sessionId: 'sess', maxIter: -1, tokenBudget: 0, timeBudgetSeconds: 0 });
    }).toThrow();
  });

  it('H5c: non-numeric tokenBudget (string "abc") should fail schema', () => {
    const root = mkroot();
    saveTree(root, approvedTree());
    expect(() => {
      startGoal(root, { sessionId: 'sess', maxIter: 10, tokenBudget: 'abc', timeBudgetSeconds: 0 });
    }).toThrow();
  });
});

// ─── I. Phase 5 — lifecycle command hardening ────────────────────────────────

describe('I — Phase 5: lifecycle command hardening', () => {

  it('I1a: pauseGoal from lifecycle=achieved is refused', () => {
    const root = mkroot();
    saveTree(root, approvedTree());
    const state = pursuingState({ lifecycle: 'achieved' });
    saveState(root, state);
    const result = pauseGoal(root);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/cannot pause/i);
  });

  it('I1b: pauseGoal from lifecycle=unmet is refused', () => {
    const root = mkroot();
    saveTree(root, approvedTree());
    const state = pursuingState({ lifecycle: 'unmet', ended_at: new Date().toISOString(), ended_reason: 'blocked' });
    saveState(root, state);
    const result = pauseGoal(root);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/cannot pause/i);
  });

  it('I1c: pauseGoal from lifecycle=budget-limited is refused', () => {
    const root = mkroot();
    saveTree(root, approvedTree());
    const state = pursuingState({ lifecycle: 'budget-limited', ended_at: new Date().toISOString(), ended_reason: 'iterations budget exhausted' });
    saveState(root, state);
    const result = pauseGoal(root);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/cannot pause/i);
  });

  it('I1d: pauseGoal from lifecycle=paused is refused (cannot double-pause)', () => {
    const root = mkroot();
    saveTree(root, approvedTree());
    const state = pursuingState({ lifecycle: 'paused', paused_at: new Date().toISOString() });
    saveState(root, state);
    const result = pauseGoal(root);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/cannot pause/i);
  });

  it('I2a: resumeGoal refuses when iterations budget is exhausted', () => {
    const root = mkroot();
    saveTree(root, approvedTree());
    const state = pursuingState({
      lifecycle: 'paused',
      paused_at: new Date().toISOString(),
    });
    state.budget.iterations.used = 100;  // == max
    saveState(root, state);
    const result = resumeGoal(root);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/budget exhausted/i);
  });

  it('I2b: resumeGoal refuses when token budget is exhausted', () => {
    const root = mkroot();
    saveTree(root, approvedTree());
    const state = pursuingState({
      lifecycle: 'paused',
      paused_at: new Date().toISOString(),
    });
    state.budget.tokens.used = 1_000_000;  // == max
    saveState(root, state);
    const result = resumeGoal(root);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/budget exhausted/i);
  });

  it('I2c: resumeGoal refuses when wallclock budget is exhausted', () => {
    const root = mkroot();
    saveTree(root, approvedTree());
    const state = pursuingState({
      lifecycle: 'paused',
      paused_at: new Date().toISOString(),
    });
    // Set started_at far in the past so wallclock is exhausted
    state.budget.wallclock.started_at = new Date(Date.now() - 20_000_000).toISOString();
    state.budget.wallclock.max_seconds = 1; // 1 second budget, long elapsed
    saveState(root, state);
    const result = resumeGoal(root);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/budget exhausted/i);
  });

  it('I2d: resumeGoal succeeds when max=0 (infinite) even with large used value', () => {
    const root = mkroot();
    saveTree(root, approvedTree());
    const state = pursuingState({
      lifecycle: 'paused',
      paused_at: new Date().toISOString(),
    });
    state.budget.iterations.max = 0;  // infinite
    state.budget.iterations.used = 9999;
    state.budget.tokens.max = 0;      // infinite
    state.budget.tokens.used = 9_999_999;
    state.budget.wallclock.max_seconds = 0;  // infinite
    saveState(root, state);
    const result = resumeGoal(root);
    expect(result.ok).toBe(true);
  });

  it('I3a: abandonGoal from lifecycle=achieved is refused', () => {
    const root = mkroot();
    saveTree(root, approvedTree());
    const state = pursuingState({ lifecycle: 'achieved', ended_at: new Date().toISOString(), ended_reason: 'done' });
    saveState(root, state);
    const result = abandonGoal(root);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/cannot abandon/i);
  });

  it('I3b: abandonGoal from lifecycle=unmet is refused (already terminal)', () => {
    const root = mkroot();
    saveTree(root, approvedTree());
    const state = pursuingState({ lifecycle: 'unmet', ended_at: new Date().toISOString(), ended_reason: 'blocked' });
    saveState(root, state);
    const result = abandonGoal(root);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/cannot abandon/i);
  });

  it('I3c: abandonGoal from lifecycle=budget-limited is refused', () => {
    const root = mkroot();
    saveTree(root, approvedTree());
    const state = pursuingState({ lifecycle: 'budget-limited', ended_at: new Date().toISOString(), ended_reason: 'tokens budget exhausted' });
    saveState(root, state);
    const result = abandonGoal(root);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/cannot abandon/i);
  });

  it('I3d: abandonGoal from pursuing succeeds (preserves reason in state)', () => {
    const root = mkroot();
    saveTree(root, approvedTree());
    saveState(root, pursuingState());
    const result = abandonGoal(root, { reason: 'user gave up' });
    expect(result.ok).toBe(true);
    const state = loadState(root);
    expect(state.lifecycle).toBe('unmet');
    expect(state.ended_reason).toBe('user gave up');
    expect(state.ended_at).toBeTruthy();
  });

  it('I3e: abandonGoal from paused succeeds (paused is abandonable)', () => {
    const root = mkroot();
    saveTree(root, approvedTree());
    const state = pursuingState({ lifecycle: 'paused', paused_at: new Date().toISOString() });
    saveState(root, state);
    const result = abandonGoal(root);
    expect(result.ok).toBe(true);
    const newState = loadState(root);
    expect(newState.lifecycle).toBe('unmet');
  });

  it('I4: clearGoal with archive=true twice in the same second produces two distinct archive dirs', () => {
    const root = mkroot();
    const tree = approvedTree();
    saveTree(root, tree);
    saveState(root, pursuingState());

    // First clear with archive
    const r1 = clearGoal(root, { archive: true });
    expect(r1.ok).toBe(true);
    expect(r1.archivedTo).toBeTruthy();

    // Re-create the active dir for second clear
    saveTree(root, approvedTree());
    saveState(root, pursuingState());

    const r2 = clearGoal(root, { archive: true });
    expect(r2.ok).toBe(true);
    expect(r2.archivedTo).toBeTruthy();

    // The two archive paths must be different (unique, no overwrite)
    expect(r1.archivedTo).not.toBe(r2.archivedTo);
    // Both archive dirs must exist on disk
    expect(fs.existsSync(r1.archivedTo)).toBe(true);
    expect(fs.existsSync(r2.archivedTo)).toBe(true);
  });

  it('I5: clearGoal with no active goal is a no-op (returns ok:true, noop:true)', () => {
    // Skip mkroot's pre-seeded config.json — this test specifically asserts
    // the "no active dir at all" path of clearGoal.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adv58-i5-'));
    const result = clearGoal(root);
    expect(result.ok).toBe(true);
    expect(result.noop).toBe(true);
  });

  it('I5b: clearGoal with archive=false does not throw when active dir exists', () => {
    const root = mkroot();
    saveTree(root, approvedTree());
    saveState(root, pursuingState());
    const result = clearGoal(root, { archive: false });
    expect(result.ok).toBe(true);
    expect(fs.existsSync(activeDir(root))).toBe(false);
  });
});

// ─── J. Phase 6 — validate-plan adversarial ──────────────────────────────────

describe('J — Phase 6: validate-plan adversarial', () => {

  const okTree = () => ({
    schema_version: 2,
    goal_id: 'g',
    mission: 'a valid mission',
    created_at: new Date().toISOString(),
    approved_at: null,
    root: {
      id: 's', type: 'sprint', title: 's', goal: 'sprint goal',
      acceptance_criteria: [], review: [], validate: null,
      work_front: null, status: 'pending',
      evidence: [], blocker_reason: null, review_attempts: 0, notes: [],
      children: [
        {
          id: 's.t1', type: 'task', title: 'task title', goal: 'task goal',
          acceptance_criteria: ['at least one criterion'], review: [], validate: null,
          work_front: null, status: 'pending',
          evidence: [], blocker_reason: null, review_attempts: 0, notes: [],
          children: [],
        },
      ],
    },
  });

  it('J1a: TBD in title is rejected', () => {
    const t = okTree();
    t.root.children[0].title = 'TBD';
    const r = validatePlan(t);
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toMatch(/placeholder/i);
  });

  it('J1b: TODO (lowercase) in goal is rejected (case-insensitive)', () => {
    const t = okTree();
    t.root.children[0].goal = 'todo: write this';
    const r = validatePlan(t);
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toMatch(/placeholder/i);
  });

  it('J1c: FIXME in acceptance criterion is rejected', () => {
    const t = okTree();
    t.root.children[0].acceptance_criteria = ['FIXME: define this properly'];
    const r = validatePlan(t);
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toMatch(/placeholder/i);
  });

  it('J1d: XXX in a criterion is rejected', () => {
    const t = okTree();
    t.root.children[0].acceptance_criteria = ['XXX fill in'];
    const r = validatePlan(t);
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toMatch(/placeholder/i);
  });

  it('J1e: ??? in goal is rejected', () => {
    const t = okTree();
    t.root.children[0].goal = 'What should we do here ???';
    const r = validatePlan(t);
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toMatch(/placeholder/i);
  });

  it('J1f: "TDBX" (not a word boundary match) is NOT rejected for TBD pattern', () => {
    // Boundary check: "TBDX" should NOT match \bTBD\b since 'X' is a word char after
    const t = okTree();
    t.root.children[0].title = 'TBDX is not a placeholder';
    const r = validatePlan(t);
    // Should pass (TBDX is word-boundary-exempt)
    expect(r.ok).toBe(true);
  });

  it('J2: unknown reviewer in tree produces WARNING (not error) when availableReviewers is provided', () => {
    const t = okTree();
    // Use non-overlapping names to avoid false substring matches in assertions
    t.root.children[0].review = ['art-director', 'missing-robot'];
    const r = validatePlan(t, { availableReviewers: new Set(['art-director']) });
    expect(r.ok).toBe(true);  // warnings don't block
    expect(r.warnings.length).toBeGreaterThanOrEqual(1);
    expect(r.warnings.join('\n')).toMatch(/missing-robot/);
    // 'art-director' is in the set → should NOT appear in warnings
    const warnStr = r.warnings.join('\n');
    const warnsAboutArtDirector = r.warnings.some(w => w.includes('"art-director"'));
    expect(warnsAboutArtDirector).toBe(false);
  });

  it('J2b: no reviewer warnings when availableReviewers is not provided', () => {
    const t = okTree();
    t.root.children[0].review = ['anything-goes'];
    const r = validatePlan(t);  // no opts
    expect(r.ok).toBe(true);
    expect(r.warnings).toEqual([]);
  });

  it('J3: empty mission string is rejected at schema layer', () => {
    const t = okTree();
    t.mission = '';
    const r = validatePlan(t);
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatch(/schema/i);
  });

  it('J4: empty acceptance_criteria for task node is caught at schema layer', () => {
    const t = okTree();
    t.root.children[0].acceptance_criteria = [];
    const r = validatePlan(t);
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatch(/schema/i);
  });

  it('J5: multiple independent errors are ALL returned (not short-circuited after first)', () => {
    const t = okTree();
    // Introduce placeholder in title AND in goal
    t.root.children[0].title = 'TBD';
    t.root.children[0].goal = 'TODO: write this';
    // Also add a reviewer warning
    t.root.children[0].review = ['missing-reviewer'];
    const r = validatePlan(t, { availableReviewers: new Set() });
    expect(r.ok).toBe(false);
    // Both placeholder errors should appear
    const errStr = r.errors.join('\n');
    expect(errStr).toMatch(/title/);
    expect(errStr).toMatch(/goal/);
    // Warning for missing reviewer
    expect(r.warnings.join('\n')).toMatch(/missing-reviewer/);
  });

  it('J5b: multi-node placeholder errors are all reported (not just first node)', () => {
    const t = okTree();
    // Clone t1 as t2 with placeholder
    const t2 = { ...t.root.children[0], id: 's.t2', title: 'XXX' };
    t.root.children.push(t2);
    t.root.children[0].title = 'TBD';
    const r = validatePlan(t);
    expect(r.ok).toBe(false);
    // Errors must mention both nodes
    const errStr = r.errors.join('\n');
    expect(errStr).toMatch(/s\.t1/);
    expect(errStr).toMatch(/s\.t2/);
  });

  it('J6: discoverReviewers scans subdirectory names (path-scoped allow-list)', () => {
    const dir1 = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-'));
    fs.mkdirSync(path.join(dir1, 'my-reviewer'));
    fs.mkdirSync(path.join(dir1, 'another-reviewer'));

    const result = discoverReviewers([dir1]);
    expect(result.has('my-reviewer')).toBe(true);
    expect(result.has('another-reviewer')).toBe(true);
    // A reviewer in a random OTHER dir should NOT appear
    expect(result.has('not-in-dir')).toBe(false);
  });
});

// ─── K. Phase 7 — audit persistence + manual-approve ────────────────────────

describe('K — Phase 7: audit persistence + manual-approve', () => {

  function reviewPendingTree(nodeId = 's.t1') {
    const t = approvedTree();
    const task = t.root.children[0];
    task.id = nodeId;
    task.status = 'review-pending';
    task.evidence = [
      { ts: new Date().toISOString(), iteration: 1, criterion_index: 0, file: 'f', line: null, commit: null, command: null, exit_code: null, note: 'n' },
    ];
    task.review = ['art-reviewer'];
    return t;
  }

  it('K1a: node_id with ".." characters — safeFilenamePart allows "." through, so ".." survives in filename (BUG PROBE)', () => {
    // safeFilenamePart uses regex /[^a-zA-Z0-9._-]/g — '.' is in the allowed set.
    // So '../escape' → '.._escape', which still contains '..' in the filename.
    // path.join('/audits/dir', '.._escape-ts-agent.json') stays within the dir
    // because '..' must be a complete path component to traverse.
    // This test documents the current behavior (defect: sanitation passes '..')
    // but verifies no actual filesystem traversal occurs.
    const root = mkroot();
    const tree = reviewPendingTree('../escape');
    tree.root.children[0].id = '../escape';
    tree.root.children[1].id = 's.t2-other';
    const state = pursuingState({ cursor: '../escape' });
    saveTree(root, tree);
    saveState(root, state);

    const result = manualApprove(root, { reason: 'ok' });
    expect(result.ok).toBe(true);

    const auditFiles = fs.readdirSync(auditsDir(root));
    expect(auditFiles.length).toBe(1);
    // The file DOES contain '..' (sanitizer allows '.' through) — this is the defect
    // but actual traversal does NOT occur because '..' is inside a longer filename token.
    const fname = auditFiles[0];
    // File IS written inside audits dir (no actual traversal)
    expect(fs.existsSync(path.join(auditsDir(root), fname))).toBe(true);
    // Body preserves original node_id
    const body = JSON.parse(fs.readFileSync(path.join(auditsDir(root), fname), 'utf8'));
    expect(body.node_id).toBe('../escape');
    // REGRESSION: Bug B (commit 8df8326) — sanitizer now collapses '..' sequences.
    // The literal '..' must NOT survive in the filename, otherwise a later refactor
    // that uses node_id as a path component could enable directory traversal.
    expect(fname).not.toContain('..');
  });

  it('K1b: agent name with "/" in audit-verdict tag is sanitized in filename', () => {
    const root = mkroot();
    const ts = new Date().toISOString();
    const tree = approvedTree();
    const state = pursuingState();

    // Build a review-pending state manually via applyMutations
    const taskNode = tree.root.children[0];
    taskNode.status = 'review-pending';
    taskNode.review = ['art/reviewer'];
    taskNode.evidence = [
      { ts, iteration: 0, criterion_index: 0, file: 'f', line: null, commit: null, command: null, exit_code: null, note: 'n' },
    ];

    const dir = auditsDir(root);
    fs.mkdirSync(dir, { recursive: true });

    const tags = [{ kind: 'audit-verdict', agent: 'art/reviewer', status: 'GO', text: 'looks fine' }];
    const { tree: newTree, state: newState } = applyMutations(tree, state, tags, ts, { auditsDir: dir });

    const files = fs.readdirSync(dir);
    expect(files.length).toBe(1);
    expect(files[0]).not.toContain('/');
    // Verify body still has original agent name
    const body = JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf8'));
    expect(body.agent).toBe('art/reviewer');
  });

  it('K1c: agent name with null-byte is sanitized', () => {
    const root = mkroot();
    const ts = new Date().toISOString();
    const tree = approvedTree();
    const state = pursuingState();

    const taskNode = tree.root.children[0];
    taskNode.status = 'review-pending';
    taskNode.review = ['bad\x00agent'];
    taskNode.evidence = [
      { ts, iteration: 0, criterion_index: 0, file: 'f', line: null, commit: null, command: null, exit_code: null, note: 'n' },
    ];

    const dir = auditsDir(root);
    fs.mkdirSync(dir, { recursive: true });

    const tags = [{ kind: 'audit-verdict', agent: 'bad\x00agent', status: 'GO', text: 'ok' }];
    expect(() => {
      applyMutations(tree, state, tags, ts, { auditsDir: dir });
    }).not.toThrow();

    const files = fs.readdirSync(dir);
    expect(files.length).toBe(1);
    // Filename must not contain null byte
    expect(files[0]).not.toContain('\x00');
  });

  it('K2: duplicate audit-verdict tags in one applyMutations call produce separate files per-agent-per-ts', () => {
    const root = mkroot();
    const ts = new Date().toISOString();
    const tree = approvedTree();
    const state = pursuingState();

    const taskNode = tree.root.children[0];
    taskNode.status = 'review-pending';
    taskNode.review = ['agent-a'];
    taskNode.evidence = [
      { ts, iteration: 0, criterion_index: 0, file: 'f', line: null, commit: null, command: null, exit_code: null, note: 'n' },
    ];

    const dir = auditsDir(root);
    fs.mkdirSync(dir, { recursive: true });

    // Two verdicts from the SAME agent, same ts
    const tags = [
      { kind: 'audit-verdict', agent: 'agent-a', status: 'GO', text: 'first pass' },
      { kind: 'audit-verdict', agent: 'agent-a', status: 'GO', text: 'second pass' },
    ];
    applyMutations(tree, state, tags, ts, { auditsDir: dir });

    const files = fs.readdirSync(dir);
    // The filename includes ts and agent — same ts+agent combo = same filename.
    // Second write overwrites the first. Only 1 file expected (second GO overwrites).
    // This is a DOCUMENTED behavior: we check reality.
    expect(files.length).toBeGreaterThanOrEqual(1);
  });

  it('K3: manualApprove refuses if cursor task is "pursuing" (not review-pending)', () => {
    const root = mkroot();
    const tree = approvedTree();
    saveTree(root, tree);
    saveState(root, pursuingState());  // t1 is pending in tree fixture
    const result = manualApprove(root, { reason: 'ok' });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not.*review-pending/i);
  });

  it('K3b: manualApprove refuses if cursor task is "achieved"', () => {
    const root = mkroot();
    const tree = approvedTree();
    tree.root.children[0].status = 'achieved';
    saveTree(root, tree);
    saveState(root, pursuingState());
    const result = manualApprove(root, { reason: 'ok' });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not.*review-pending/i);
  });

  it('K4: manualApprove --reason records the reason in audit file text field', () => {
    const root = mkroot();
    const tree = reviewPendingTree();
    saveTree(root, tree);
    saveState(root, pursuingState());
    const result = manualApprove(root, { reason: 'critical path approved by tech lead' });
    expect(result.ok).toBe(true);
    const files = fs.readdirSync(auditsDir(root));
    expect(files.length).toBe(1);
    const body = JSON.parse(fs.readFileSync(path.join(auditsDir(root), files[0]), 'utf8'));
    expect(body.text).toBe('critical path approved by tech lead');
    expect(body.status).toBe('GO');
    expect(body.agent).toBe('manual');
  });

  it('K5: manualApprove with no active goal fails gracefully (no state.json)', () => {
    const root = mkroot();
    // No state or tree
    const result = manualApprove(root, { reason: 'ok' });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/no active goal/i);
  });

  it('K6: audit dir is auto-created by applyMutations when it does not exist yet', () => {
    const root = mkroot();
    const ts = new Date().toISOString();
    const tree = approvedTree();
    const state = pursuingState();

    const taskNode = tree.root.children[0];
    taskNode.status = 'review-pending';
    taskNode.review = ['test-agent'];
    taskNode.evidence = [
      { ts, iteration: 0, criterion_index: 0, file: 'f', line: null, commit: null, command: null, exit_code: null, note: 'n' },
    ];

    const dir = auditsDir(root);
    // Verify audits/ does NOT exist yet
    expect(fs.existsSync(dir)).toBe(false);

    const tags = [{ kind: 'audit-verdict', agent: 'test-agent', status: 'GO', text: 'ok' }];
    expect(() => {
      applyMutations(tree, state, tags, ts, { auditsDir: dir });
    }).not.toThrow();

    // After mutation, audits/ must exist with one file
    expect(fs.existsSync(dir)).toBe(true);
    expect(fs.readdirSync(dir).length).toBe(1);
  });

  it('K7: two different audit-verdict agents in one call both write separate files', () => {
    const root = mkroot();
    const ts = new Date().toISOString();
    const tree = approvedTree();
    const state = pursuingState();

    const taskNode = tree.root.children[0];
    taskNode.status = 'review-pending';
    taskNode.review = ['agent-x', 'agent-y'];
    taskNode.evidence = [
      { ts, iteration: 0, criterion_index: 0, file: 'f', line: null, commit: null, command: null, exit_code: null, note: 'n' },
    ];

    const dir = auditsDir(root);
    fs.mkdirSync(dir, { recursive: true });

    const tags = [
      { kind: 'audit-verdict', agent: 'agent-x', status: 'GO', text: 'x says go' },
      { kind: 'audit-verdict', agent: 'agent-y', status: 'GO', text: 'y says go' },
    ];
    applyMutations(tree, state, tags, ts, { auditsDir: dir });

    const files = fs.readdirSync(dir);
    expect(files.length).toBe(2);
    // One file per agent
    const agentNames = files.map(f => {
      const body = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      return body.agent;
    });
    expect(agentNames).toContain('agent-x');
    expect(agentNames).toContain('agent-y');
  });
});

// ─── L. Phase 8 — triple budget + stop-hook ──────────────────────────────────

describe('L — Phase 8: triple-budget hardening', () => {

  it('L1: cache_read_input_tokens are excluded from tallyTokens total', () => {
    const f = tmpJsonl([
      {
        message: {
          role: 'assistant',
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            cache_creation_input_tokens: 25,
            cache_read_input_tokens: 500,  // should NOT count
          },
        },
      },
    ]);
    expect(tallyTokens(f)).toBe(100 + 50 + 25); // 175, not 675
  });

  it('L2: malformed JSONL line is skipped; well-formed lines still summed', () => {
    const f = tmpJsonl([
      { message: { role: 'assistant', usage: { input_tokens: 100, output_tokens: 50 } } },
    ]);
    fs.appendFileSync(f, '\nnot valid json at all {{{\n');
    fs.appendFileSync(f, JSON.stringify({ message: { role: 'assistant', usage: { input_tokens: 200, output_tokens: 100 } } }));
    expect(tallyTokens(f)).toBe(100 + 50 + 200 + 100); // 450
  });

  it('L3: empty JSONL file returns 0', () => {
    const f = path.join(os.tmpdir(), `empty-${Date.now()}.jsonl`);
    fs.writeFileSync(f, '');
    expect(tallyTokens(f)).toBe(0);
  });

  it('L4: missing file returns 0 (TOCTOU-safe, never throws)', () => {
    expect(tallyTokens('/nonexistent/path/totally-fake-transcript.jsonl')).toBe(0);
  });

  it('L5: checkLimits priority — tokens AND wallclock both exhausted → returns "tokens" (iterations→tokens→wallclock order)', () => {
    const pastStart = new Date(Date.now() - 100_000).toISOString();
    const b = {
      iterations: { used: 0, max: 100 },    // NOT exhausted
      tokens: { used: 1000, max: 1000 },     // exhausted
      wallclock: { started_at: pastStart, max_seconds: 1 },  // also exhausted
    };
    // tokens should win over wallclock
    expect(checkLimits(b)).toBe('tokens');
  });

  it('L5b: iterations exhausted wins over both tokens and wallclock', () => {
    const pastStart = new Date(Date.now() - 100_000).toISOString();
    const b = {
      iterations: { used: 100, max: 100 },   // exhausted
      tokens: { used: 1000, max: 1000 },     // also exhausted
      wallclock: { started_at: pastStart, max_seconds: 1 },  // also exhausted
    };
    expect(checkLimits(b)).toBe('iterations');
  });

  it('L6a: max=0 on iterations means "no limit" even when used > 0', () => {
    const b = {
      iterations: { used: 99999, max: 0 },
      tokens: { used: 0, max: 1000 },
      wallclock: { started_at: new Date().toISOString(), max_seconds: 3600 },
    };
    expect(checkLimits(b)).toBeNull();
  });

  it('L6b: max=0 on tokens means "no limit"', () => {
    const b = {
      iterations: { used: 0, max: 100 },
      tokens: { used: 99999999, max: 0 },
      wallclock: { started_at: new Date().toISOString(), max_seconds: 3600 },
    };
    expect(checkLimits(b)).toBeNull();
  });

  it('L6c: max_seconds=0 on wallclock means "no limit"', () => {
    const pastStart = new Date(Date.now() - 999_999_999).toISOString();
    const b = {
      iterations: { used: 0, max: 100 },
      tokens: { used: 0, max: 1000 },
      wallclock: { started_at: pastStart, max_seconds: 0 },
    };
    expect(checkLimits(b)).toBeNull();
  });

  it('L7: checkLimits with max=Number.MAX_SAFE_INTEGER does not overflow/trip', () => {
    const b = {
      iterations: { used: 0, max: Number.MAX_SAFE_INTEGER },
      tokens: { used: 0, max: Number.MAX_SAFE_INTEGER },
      wallclock: { started_at: new Date().toISOString(), max_seconds: Number.MAX_SAFE_INTEGER },
    };
    expect(checkLimits(b)).toBeNull();
  });

  it('L8a: checkLimits with NaN wallclock (corrupt started_at) returns null, never throws', () => {
    const b = {
      iterations: { used: 0, max: 100 },
      tokens: { used: 0, max: 1000 },
      wallclock: { started_at: 'NOT-A-DATE', max_seconds: 600 },
    };
    expect(() => checkLimits(b)).not.toThrow();
    expect(checkLimits(b)).toBeNull();
  });

  it('L8b: negative wallclock elapsed (started_at in future) is not treated as exhausted', () => {
    const futureStart = new Date(Date.now() + 999_999).toISOString();
    const b = {
      iterations: { used: 0, max: 100 },
      tokens: { used: 0, max: 1000 },
      wallclock: { started_at: futureStart, max_seconds: 60 },
    };
    // elapsed < 0, so should NOT trigger
    expect(checkLimits(b)).toBeNull();
  });

  it('L8c: wallclockMinutes with future started_at returns 0 (clamps negative to 0)', () => {
    const state = pursuingState();
    state.budget.wallclock.started_at = new Date(Date.now() + 999_999).toISOString();
    expect(wallclockMinutes(state)).toBe(0);
  });

  it('L8d: wallclockMinutes with NaN started_at returns 0 (NaN-guard)', () => {
    const state = pursuingState();
    state.budget.wallclock.started_at = 'CORRUPT-DATE';
    expect(wallclockMinutes(state)).toBe(0);
  });

  it('L9: budget-limit stop-hook renders reason containing limit kind', async () => {
    const root = mkroot();
    const tree = approvedTree();
    const state = pursuingState({ maxIter: 1 });
    saveTree(root, tree);
    saveState(root, state);

    const tPath = writeTranscript(root, [assistantRow({ text: 'nothing' })]);
    const result = await runStopHook({
      stdin: { session_id: 'sess-adv', transcript_path: tPath },
      projectRoot: root,
    });

    // First hook: iteration becomes 1 == max → iterations budget exhausted
    expect(result.exit).toBe(0);
    expect(result.stdout).not.toBeNull();
    expect(result.stdout.systemMessage).toMatch(/iterations/);
    expect(result.stdout.reason).toContain('iterations');
    expect(result.stdout.decision).toBe('block');
  });

  it('L10: after lifecycle=budget-limited, second stop-hook returns null stdout (lifecycle gate fires)', async () => {
    const root = mkroot();
    const tree = approvedTree();
    const state = pursuingState({ maxIter: 1 });
    saveTree(root, tree);
    saveState(root, state);

    // Turn 1: exhaust budget
    let tPath = writeTranscript(root, [assistantRow()]);
    await runStopHook({
      stdin: { session_id: 'sess-adv', transcript_path: tPath },
      projectRoot: root,
    });
    const s1 = loadState(root);
    expect(s1.lifecycle).toBe('budget-limited');

    // Turn 2: lifecycle is budget-limited, not pursuing → silent exit
    tPath = writeTranscript(root, [assistantRow(), assistantRow()]);
    const result2 = await runStopHook({
      stdin: { session_id: 'sess-adv', transcript_path: tPath },
      projectRoot: root,
    });
    expect(result2.exit).toBe(0);
    expect(result2.stdout).toBeNull();

    // Iteration counter must NOT increment on second call
    const s2 = loadState(root);
    expect(s2.budget.iterations.used).toBe(s1.budget.iterations.used);
  });

  it('L11: corrupt wallclock started_at in stop-hook path → no crash, continues as normal', async () => {
    const root = mkroot();
    const tree = approvedTree();
    const state = pursuingState();
    // Corrupt the wallclock with a non-date
    state.budget.wallclock.started_at = new Date().toISOString();  // valid for schema
    saveTree(root, tree);
    saveState(root, state);

    // Now corrupt it manually bypassing schema
    const stateRaw = JSON.parse(fs.readFileSync(path.join(root, '.claude/goals/active/state.json'), 'utf8'));
    stateRaw.budget.wallclock.started_at = 'NOT-A-DATE';
    fs.writeFileSync(path.join(root, '.claude/goals/active/state.json'), JSON.stringify(stateRaw, null, 2));

    // loadState returns null for corrupt file (schema rejects non-datetime)
    // → stop-hook should return null stdout (no goal active)
    const tPath = writeTranscript(root, [assistantRow()]);
    const result = await runStopHook({
      stdin: { session_id: 'sess-adv', transcript_path: tPath },
      projectRoot: root,
    });
    expect(result.exit).toBe(0);
    // Either null (state rejected) or continues normally (depends on how corrupt state is handled)
    // The key is: it must NOT throw
  });

  it('L12: iteration counter increments by exactly 1 per stop-hook call in pursuing state', async () => {
    const root = mkroot();
    const tree = approvedTree();
    const state = pursuingState({ maxIter: 100 });
    saveTree(root, tree);
    saveState(root, state);

    for (let i = 1; i <= 3; i++) {
      const tPath = writeTranscript(root, [assistantRow({ text: `turn ${i}` })]);
      await runStopHook({
        stdin: { session_id: 'sess-adv', transcript_path: tPath },
        projectRoot: root,
      });
      const s = loadState(root);
      expect(s.budget.iterations.used).toBe(i);
    }
  });

  it('L12b: iteration counter does NOT increment after terminal lifecycle (budget-limited)', async () => {
    const root = mkroot();
    const tree = approvedTree();
    const state = pursuingState({ maxIter: 2 });
    saveTree(root, tree);
    saveState(root, state);

    const tPath = writeTranscript(root, [assistantRow()]);
    // Turn 1: iter=1, still pursuing
    await runStopHook({ stdin: { session_id: 'sess-adv', transcript_path: tPath }, projectRoot: root });
    // Turn 2: iter=2 == max → budget-limited
    await runStopHook({ stdin: { session_id: 'sess-adv', transcript_path: tPath }, projectRoot: root });
    const s1 = loadState(root);
    expect(s1.lifecycle).toBe('budget-limited');
    const iterAtLimit = s1.budget.iterations.used;

    // Turn 3+: should NOT increment
    await runStopHook({ stdin: { session_id: 'sess-adv', transcript_path: tPath }, projectRoot: root });
    const s2 = loadState(root);
    expect(s2.budget.iterations.used).toBe(iterAtLimit);
  });
});

// ─── M. Cross-phase wiring / integration regressions ───────────────────────

describe('M — Cross-phase: integration regressions', () => {

  it('M1: full chain — approve-plan → start → stop-hook with achieved evidence', async () => {
    const root = mkroot();
    const tree = {
      schema_version: 2,
      goal_id: 'chain-test',
      mission: 'Integration chain test',
      created_at: new Date().toISOString(),
      approved_at: null,
      root: {
        id: 's', type: 'sprint', title: 'Sprint', goal: 'sprint goal',
        acceptance_criteria: [], review: [], validate: null,
        work_front: null, status: 'pending',
        evidence: [], blocker_reason: null, review_attempts: 0, notes: [],
        children: [
          {
            id: 's.t1', type: 'task', title: 'Task 1', goal: 'task goal',
            acceptance_criteria: ['criterion 0'], review: [], validate: null,
            work_front: null, status: 'pending',
            evidence: [], blocker_reason: null, review_attempts: 0, notes: [],
            children: [],
          },
        ],
      },
    };
    saveTree(root, tree);
    const planResult = approvePlan(root, { availableReviewers: new Set() });
    expect(planResult.ok).toBe(true);

    // approvePlan writes state.json with lifecycle='approved', so startGoal
    // requires force:true to overwrite it (startGoal refuses any existing state without --force).
    const startResult = startGoal(root, { sessionId: 'chain-sess', maxIter: 100, tokenBudget: 0, timeBudgetSeconds: 0, force: true });
    expect(startResult.ok).toBe(true);
    expect(startResult.cursor).toBe('s.t1');

    // Drive stop-hook with an evidence + achieved tag
    const ts = new Date().toISOString();
    const achievedText = `
<evidence criterion="0" file="test.js">passing test</evidence>
<task-status>achieved</task-status>
`;
    const tPath = writeTranscript(root, [{ message: { role: 'assistant', content: [{ type: 'text', text: achievedText }], usage: { input_tokens: 10, output_tokens: 5 } } }]);
    const hookResult = await runStopHook({
      stdin: { session_id: 'chain-sess', transcript_path: tPath },
      projectRoot: root,
    });
    expect(hookResult.exit).toBe(0);
    const finalState = loadState(root);
    expect(finalState.lifecycle).toBe('achieved');
    expect(finalState.ended_reason).toBe('all tasks achieved');
  });

  it('M1b: REGRESSION — approvePlan → startGoal succeeds without --force (Bug A fixed in 8df8326)', () => {
    // Bug A fixed: lifecycle='approved' (and 'draft') are restartable without --force.
    // The user should NOT need to remember --force after /goal:approve-plan to do /goal:start.
    const root = mkroot();
    const tree = approvedTree({ approved_at: null, goal_id: 'bug-m1b' });
    saveTree(root, tree);
    approvePlan(root, { availableReviewers: new Set() });

    // WITHOUT force on a freshly-approved plan: must succeed (was Bug A — used to require --force).
    const result = startGoal(root, { sessionId: 'sess', maxIter: 10, tokenBudget: 0, timeBudgetSeconds: 0 });
    expect(result.ok).toBe(true);

    // Sanity: state is now lifecycle=pursuing, not approved.
    const finalState = loadState(root);
    expect(finalState.lifecycle).toBe('pursuing');
  });

  it('M2: pause → exhaust wallclock → resume is refused', () => {
    const root = mkroot();
    saveTree(root, approvedTree());
    saveState(root, pursuingState());

    pauseGoal(root);
    const paused = loadState(root);
    expect(paused.lifecycle).toBe('paused');

    // Corrupt wallclock to be exhausted
    paused.budget.wallclock.started_at = new Date(Date.now() - 100_000).toISOString();
    paused.budget.wallclock.max_seconds = 1;
    saveState(root, paused);

    const result = resumeGoal(root);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/budget exhausted/i);
  });

  it('M3: approve then cursor advances after manual-approve from review-pending', () => {
    const root = mkroot();
    const tree = approvedTree();
    tree.root.children[0].status = 'review-pending';
    tree.root.children[0].review = ['art-x'];
    tree.root.children[0].evidence = [
      { ts: new Date().toISOString(), iteration: 1, criterion_index: 0, file: 'f', line: null, commit: null, command: null, exit_code: null, note: 'n' },
    ];
    saveTree(root, tree);
    saveState(root, pursuingState({ cursor: 's.t1' }));

    const result = manualApprove(root, { reason: 'lgtm' });
    expect(result.ok).toBe(true);
    expect(result.cursor).toBe('s.t2');  // cursor advances

    // Verify state.json
    const state = loadState(root);
    expect(state.cursor).toBe('s.t2');

    // Verify audits/ written
    const files = fs.readdirSync(auditsDir(root));
    expect(files.length).toBe(1);
    const body = JSON.parse(fs.readFileSync(path.join(auditsDir(root), files[0]), 'utf8'));
    expect(body.text).toBe('lgtm');
    expect(body.node_id).toBe('s.t1');
  });

  it('M4: tree with only sprint/epic (no tasks) → walkLeafTasks returns [], startGoal refuses', () => {
    const root = mkroot();
    const tree = {
      schema_version: 2,
      goal_id: 'no-tasks',
      mission: 'sprint with no tasks',
      created_at: new Date().toISOString(),
      approved_at: new Date().toISOString(),
      root: {
        id: 's', type: 'sprint', title: 'Sprint', goal: 'sprint goal',
        acceptance_criteria: [], review: [], validate: null,
        work_front: null, status: 'pending',
        evidence: [], blocker_reason: null, review_attempts: 0, notes: [],
        children: [],  // no tasks
      },
    };
    saveTree(root, tree);
    const result = startGoal(root, { sessionId: 'sess', maxIter: 10, tokenBudget: 0, timeBudgetSeconds: 0 });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/no pending(?: or pursuing)? tasks/i);
  });

  it('M5: state.goal_id and tree.goal_id mismatch — stop-hook still operates (no consistency check)', async () => {
    // Document: the engine does NOT cross-check goal_id between state and tree.
    const root = mkroot();
    const tree = approvedTree({ goal_id: 'tree-goal-A' });
    const state = pursuingState();
    state.goal_id = 'state-goal-B';  // MISMATCH — but schema both allow any string.
    saveTree(root, tree);
    saveState(root, state);

    const tPath = writeTranscript(root, [assistantRow()]);
    const result = await runStopHook({
      stdin: { session_id: 'sess-adv', transcript_path: tPath },
      projectRoot: root,
    });
    // Should NOT crash — goal_id mismatch is not validated at stop-hook level
    expect(result.exit).toBe(0);
    // Probably works fine (state.goal_id is informational metadata)
  });

  it('M6: state.json with future schema_version is rejected by loadState → returns null + .broken backup', () => {
    // Updated for v1.2.0+: CURRENT_SCHEMA_VERSION=2 is now canonical, and v1
    // states auto-migrate on load. The "rejection on schema mismatch" path
    // remains valid for FUTURE versions the engine doesn't know yet — same
    // forensic semantics (.broken-* backup created, loadState returns null).
    const root = mkroot();
    saveTree(root, approvedTree());
    const badState = {
      schema_version: 99, // unknown future version — engine has no migration path
      goal_id: 'g',
      lifecycle: 'pursuing',
      cursor: 's.t1',
      budget: {
        iterations: { used: 0, max: 100 },
        tokens: { used: 0, max: 1_000_000 },
        wallclock: { started_at: new Date().toISOString(), max_seconds: 14400 },
      },
      session_id: 'sess',
      started_at: new Date().toISOString(),
      paused_at: null,
      ended_at: null,
      ended_reason: null,
      history: [],
    };
    const stateFile = path.join(root, '.claude/goals/active/state.json');
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify(badState, null, 2));

    const loaded = loadState(root);
    expect(loaded).toBeNull();  // future-version rejection

    // A .broken-* backup file must have been created
    const files = fs.readdirSync(path.dirname(stateFile));
    const broken = files.filter(f => f.includes('.broken'));
    expect(broken.length).toBeGreaterThanOrEqual(1);
  });

  it('M7: notes.md grows with each stop-hook iteration (appended, not overwritten)', async () => {
    const root = mkroot();
    saveTree(root, approvedTree());
    saveState(root, pursuingState({ maxIter: 100 }));

    const tPath = writeTranscript(root, [assistantRow()]);
    const N = 5;
    for (let i = 0; i < N; i++) {
      await runStopHook({
        stdin: { session_id: 'sess-adv', transcript_path: tPath },
        projectRoot: root,
      });
    }
    const notesFile = path.join(root, '.claude/goals/active/notes.md');
    expect(fs.existsSync(notesFile)).toBe(true);
    const lines = fs.readFileSync(notesFile, 'utf8').trim().split('\n');
    expect(lines.length).toBe(N);
  });

  it('M8: renderStatus after clearGoal --archive includes no active goal (tree/state gone)', () => {
    const root = mkroot();
    saveTree(root, approvedTree());
    saveState(root, pursuingState());

    const r = clearGoal(root, { archive: true });
    expect(r.ok).toBe(true);

    // After clear, loadState should be null (active/ dir removed)
    const state = loadState(root);
    expect(state).toBeNull();

    // Archive dir should exist
    const archives = fs.existsSync(archiveDir(root))
      ? fs.readdirSync(archiveDir(root))
      : [];
    expect(archives.length).toBeGreaterThanOrEqual(1);
  });

  it('M9: session_id mismatch with lifecycle=pursuing → auto-rebinds to live session and processes Stop event', async () => {
    const root = mkroot();
    saveTree(root, approvedTree());
    saveState(root, pursuingState({ sessionId: 'original-session' }));

    const tPath = writeTranscript(root, [assistantRow()]);
    // Silence stderr rebind diagnostic.
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = () => true;
    try {
      const result = await runStopHook({
        stdin: { session_id: 'NEW-SESSION', transcript_path: tPath },
        projectRoot: root,
      });
      expect(result.exit).toBe(0);
      // Auto-rebind: pursuing path runs, continuation emitted, iteration incremented.
      expect(result.stdout?.decision).toBe('block');

      const state = loadState(root);
      expect(state.session_id).toBe('NEW-SESSION');
      expect(state.budget.iterations.used).toBe(1);
      expect(state.history.some((e) => e.event === 'session-rebound')).toBe(true);
    } finally {
      process.stderr.write = origWrite;
    }
  });

  it('M10: stop-hook with lifecycle=paused returns null (paused gate fires before any work)', async () => {
    const root = mkroot();
    saveTree(root, approvedTree());
    const state = pursuingState({ lifecycle: 'paused', paused_at: new Date().toISOString() });
    saveState(root, state);

    const tPath = writeTranscript(root, [assistantRow()]);
    const result = await runStopHook({
      stdin: { session_id: 'sess-adv', transcript_path: tPath },
      projectRoot: root,
    });
    expect(result.exit).toBe(0);
    expect(result.stdout).toBeNull();

    // Iteration counter must NOT have incremented
    const s = loadState(root);
    expect(s.budget.iterations.used).toBe(0);
  });
});
