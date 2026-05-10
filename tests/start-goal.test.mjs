import { describe, it, expect } from 'vitest';
import { startGoal } from '../engine/start-goal.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { saveTree } from '../engine/state.mjs';

const approvedTree = () => ({
  schema_version: 1,
  goal_id: 'g',
  mission: 'm',
  created_at: '2026-05-09T00:00:00.000Z',
  approved_at: '2026-05-09T00:00:00.000Z',
  root: {
    id: 's', type: 'sprint', title: 's', goal: 'g',
    acceptance_criteria: [], review: [], validate: null,
    work_front: null, status: 'pending',
    evidence: [], blocker_reason: null, review_attempts: 0, notes: [],
    children: [
      {
        id: 's.t1', type: 'task', title: 't1', goal: 'g',
        acceptance_criteria: ['c0'], review: [], validate: null,
        work_front: null, status: 'pending',
        evidence: [], blocker_reason: null, review_attempts: 0, notes: [],
        children: [],
      },
    ],
  },
});

describe('startGoal', () => {
  it('initializes state with cursor=first pending task and lifecycle=pursuing', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-'));
    saveTree(root, approvedTree());
    const result = startGoal(root, { sessionId: 'sess', maxIter: 50, tokenBudget: 1_000_000, timeBudgetSeconds: 7200 });
    expect(result.ok).toBe(true);
    const state = JSON.parse(fs.readFileSync(path.join(root, '.claude/goals/active/state.json'), 'utf8'));
    expect(state.lifecycle).toBe('pursuing');
    expect(state.cursor).toBe('s.t1');
    expect(state.session_id).toBe('sess');
    expect(state.budget.iterations.max).toBe(50);
  });

  it('refuses if no tree.json exists', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-'));
    const result = startGoal(root, { sessionId: 's', maxIter: 1, tokenBudget: 1, timeBudgetSeconds: 1 });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/no .* tree/i);
  });

  it('refuses if tree is not approved (approved_at is null)', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-'));
    const tree = approvedTree();
    tree.approved_at = null;
    saveTree(root, tree);
    const result = startGoal(root, { sessionId: 's', maxIter: 1, tokenBudget: 1, timeBudgetSeconds: 1 });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not approved/i);
  });

  it('refuses if no pending tasks remain in tree', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-'));
    const tree = approvedTree();
    tree.root.children[0].status = 'achieved';
    saveTree(root, tree);
    const result = startGoal(root, { sessionId: 's', maxIter: 1, tokenBudget: 1, timeBudgetSeconds: 1 });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/no pending(?: or pursuing)? tasks/i);
  });

  it('writes a started history event', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-'));
    saveTree(root, approvedTree());
    startGoal(root, { sessionId: 'sess', maxIter: 50, tokenBudget: 1_000_000, timeBudgetSeconds: 7200 });
    const state = JSON.parse(fs.readFileSync(path.join(root, '.claude/goals/active/state.json'), 'utf8'));
    expect(state.history.length).toBe(1);
    expect(state.history[0].event).toBe('started');
    expect(state.history[0].node_id).toBe('s.t1');
    expect(state.history[0].iteration).toBe(0);
  });
});

describe('startGoal hardening fix-ups', () => {
  it('records iteration=0 in the started history event (M-1)', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-'));
    saveTree(root, approvedTree());
    startGoal(root, { sessionId: 'sess', maxIter: 50, tokenBudget: 1_000_000, timeBudgetSeconds: 7200 });
    const state = JSON.parse(fs.readFileSync(path.join(root, '.claude/goals/active/state.json'), 'utf8'));
    expect(state.history[0].iteration).toBe(0);
  });

  it('refuses to overwrite an active goal without force (M-2)', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-'));
    saveTree(root, approvedTree());
    const first = startGoal(root, { sessionId: 'sess1', maxIter: 50, tokenBudget: 1_000_000, timeBudgetSeconds: 7200 });
    expect(first.ok).toBe(true);

    const second = startGoal(root, { sessionId: 'sess2', maxIter: 100, tokenBudget: 2_000_000, timeBudgetSeconds: 14400 });
    expect(second.ok).toBe(false);
    expect(second.error).toMatch(/already active/i);

    // First-call session_id preserved.
    const state = JSON.parse(fs.readFileSync(path.join(root, '.claude/goals/active/state.json'), 'utf8'));
    expect(state.session_id).toBe('sess1');
    expect(state.budget.iterations.max).toBe(50);
  });

  it('overwrites prior state when force=true (M-2)', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-'));
    saveTree(root, approvedTree());
    startGoal(root, { sessionId: 'sess1', maxIter: 50, tokenBudget: 1_000_000, timeBudgetSeconds: 7200 });

    const second = startGoal(root, { sessionId: 'sess2', maxIter: 100, tokenBudget: 2_000_000, timeBudgetSeconds: 14400, force: true });
    expect(second.ok).toBe(true);

    const state = JSON.parse(fs.readFileSync(path.join(root, '.claude/goals/active/state.json'), 'utf8'));
    expect(state.session_id).toBe('sess2');
    expect(state.budget.iterations.max).toBe(100);
  });

  it('accepts a tree with first leaf already pursuing as the cursor target (M-3)', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-'));
    const tree = approvedTree();
    tree.root.children[0].status = 'pursuing';
    saveTree(root, tree);
    const result = startGoal(root, { sessionId: 'sess', maxIter: 50, tokenBudget: 1_000_000, timeBudgetSeconds: 7200 });
    expect(result.ok).toBe(true);
    expect(result.cursor).toBe('s.t1');
  });

  it('refuses if all leaves are achieved/blocked/skipped with no pending or pursuing (M-3)', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-'));
    const tree = approvedTree();
    tree.root.children[0].status = 'achieved';
    saveTree(root, tree);
    const result = startGoal(root, { sessionId: 'sess', maxIter: 50, tokenBudget: 1_000_000, timeBudgetSeconds: 7200 });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/no pending or pursuing/i);
  });
});

describe('startGoal post-1.0.0 hardening (Bug A — restartable lifecycles)', () => {
  // Bug A regression: M-2 ("refuse double-startGoal without --force") was
  // too aggressive — it also blocked the canonical `/goal:plan →
  // /goal:approve-plan → /goal:start` workflow because approvePlan writes
  // a `lifecycle=approved` state to record the plan-approved history event.
  // Fix: restartable lifecycles (draft, approved) skip the M-2 gate.

  function setupWithState(stateLifecycle) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bug-a-'));
    saveTree(root, approvedTree());
    // Synthesize a state.json with the given lifecycle (mimicking what
    // approvePlan writes after /goal:approve-plan).
    const adir = path.join(root, '.claude/goals/active');
    fs.mkdirSync(adir, { recursive: true });
    fs.writeFileSync(path.join(adir, 'state.json'), JSON.stringify({
      schema_version: 1,
      goal_id: 'g',
      lifecycle: stateLifecycle,
      cursor: 'pending',
      budget: {
        iterations: { used: 0, max: 0 },
        tokens: { used: 0, max: 0 },
        wallclock: { started_at: '2026-05-09T00:00:00.000Z', max_seconds: 0 },
      },
      session_id: 'pending',
      started_at: null, paused_at: null, ended_at: null, ended_reason: null,
      history: [{ ts: '2026-05-09T00:00:00.000Z', iteration: 0, event: 'plan-approved', node_id: null, payload: {} }],
    }, null, 2));
    return root;
  }

  it('Bug A: accepts /goal:start when state.lifecycle === approved without --force', () => {
    const root = setupWithState('approved');
    const result = startGoal(root, { sessionId: 'sess', maxIter: 50, tokenBudget: 1_000_000, timeBudgetSeconds: 7200 });
    expect(result.ok).toBe(true);
    expect(result.cursor).toBe('s.t1');
    const state = JSON.parse(fs.readFileSync(path.join(root, '.claude/goals/active/state.json'), 'utf8'));
    expect(state.lifecycle).toBe('pursuing');
    expect(state.session_id).toBe('sess');
  });

  it('Bug A: accepts /goal:start when state.lifecycle === draft without --force', () => {
    const root = setupWithState('draft');
    const result = startGoal(root, { sessionId: 'sess', maxIter: 50, tokenBudget: 1_000_000, timeBudgetSeconds: 7200 });
    expect(result.ok).toBe(true);
    const state = JSON.parse(fs.readFileSync(path.join(root, '.claude/goals/active/state.json'), 'utf8'));
    expect(state.lifecycle).toBe('pursuing');
  });

  it('Bug A: still refuses without --force on pursuing/paused/achieved/unmet/budget-limited (M-2 protection preserved)', () => {
    for (const lifecycle of ['pursuing', 'paused', 'achieved', 'unmet', 'budget-limited']) {
      const root = setupWithState(lifecycle);
      const result = startGoal(root, { sessionId: 'sess2', maxIter: 50, tokenBudget: 1_000_000, timeBudgetSeconds: 7200 });
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/already active/i);
      // Original session_id preserved (not overwritten).
      const state = JSON.parse(fs.readFileSync(path.join(root, '.claude/goals/active/state.json'), 'utf8'));
      expect(state.lifecycle).toBe(lifecycle);
    }
  });

});

// May 2026 finding: Desktop's embedded Claude Code subprocess does not export
// CLAUDE_CODE_SESSION_ID; the session id propagates as `--resume <uuid>` CLI
// arg. start-goal-cli derives the UUID by scanning ~/.claude/projects/<encoded
// -cwd>/ for the most-recent .jsonl file (its basename = session UUID). Same
// dir is written by both CLI and Desktop, so this works in both environments.
describe('deriveSessionIdFromTranscript (Desktop & CLI session-id source)', () => {
  it('returns the basename of the most-recently-modified .jsonl', async () => {
    const { deriveSessionIdFromTranscript } = await import('../engine/start-goal-cli.mjs');
    // Synthetic project transcript dir.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-deriv-'));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'project-'));
    const encoded = '-' + cwd.replace(/^\//, '').replace(/\//g, '-');
    const dir = path.join(home, '.claude', 'projects', encoded);
    fs.mkdirSync(dir, { recursive: true });
    // Two transcripts, set explicit mtimes so the test is deterministic.
    const oldUuid = '00000000-old0-0000-0000-000000000000';
    const newUuid = '11111111-new1-1111-1111-111111111111';
    fs.writeFileSync(path.join(dir, `${oldUuid}.jsonl`), '');
    const oldTime = new Date('2026-05-09T00:00:00Z');
    fs.utimesSync(path.join(dir, `${oldUuid}.jsonl`), oldTime, oldTime);
    fs.writeFileSync(path.join(dir, `${newUuid}.jsonl`), '');
    const newTime = new Date('2026-05-10T12:00:00Z');
    fs.utimesSync(path.join(dir, `${newUuid}.jsonl`), newTime, newTime);

    // os.homedir()-based lookup; rebind via env override.
    const origHome = process.env.HOME;
    process.env.HOME = home;
    try {
      expect(deriveSessionIdFromTranscript(cwd)).toBe(newUuid);
    } finally {
      process.env.HOME = origHome;
    }
  });

  it('returns null when no transcripts exist', async () => {
    const { deriveSessionIdFromTranscript } = await import('../engine/start-goal-cli.mjs');
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-deriv-empty-'));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'project-empty-'));
    const origHome = process.env.HOME;
    process.env.HOME = home;
    try {
      expect(deriveSessionIdFromTranscript(cwd)).toBeNull();
    } finally {
      process.env.HOME = origHome;
    }
  });
});
