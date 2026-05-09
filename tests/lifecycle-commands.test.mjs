import { describe, it, expect } from 'vitest';
import { pauseGoal, resumeGoal, clearGoal, abandonGoal } from '../engine/lifecycle-commands.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { saveState, saveTree } from '../engine/state.mjs';

const sampleTree = () => ({
  schema_version: 1, goal_id: 'g', mission: 'm',
  created_at: '2026-05-09T00:00:00.000Z',
  approved_at: '2026-05-09T00:00:00.000Z',
  root: {
    id: 't', type: 'task', title: 'T', goal: 'g',
    acceptance_criteria: ['c0'], review: [], validate: null,
    work_front: null, status: 'pursuing',
    evidence: [], blocker_reason: null, review_attempts: 0, notes: [],
    children: [],
  },
});

const pursuingState = (cursor = 't') => ({
  schema_version: 1, goal_id: 'g', lifecycle: 'pursuing', cursor,
  budget: {
    iterations: { used: 5, max: 100 },
    tokens: { used: 0, max: 1_000_000 },
    // Fresh started_at so wallclock budget isn't already exhausted by
    // the time the test runs (max_seconds: 14400 = 4h window).
    wallclock: { started_at: new Date().toISOString(), max_seconds: 14400 },
  },
  session_id: 'sess-1',
  started_at: new Date().toISOString(),
  paused_at: null, ended_at: null, ended_reason: null,
  history: [],
});

function setup(tree, state) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-'));
  if (tree) saveTree(root, tree);
  if (state) saveState(root, state);
  return root;
}

describe('pauseGoal', () => {
  it('transitions pursuing → paused with paused_at timestamp', () => {
    const root = setup(sampleTree(), pursuingState());
    const result = pauseGoal(root);
    expect(result.ok).toBe(true);
    const state = JSON.parse(fs.readFileSync(path.join(root, '.claude/goals/active/state.json'), 'utf8'));
    expect(state.lifecycle).toBe('paused');
    expect(state.paused_at).toBeTruthy();
    const last = state.history[state.history.length - 1];
    expect(last.event).toBe('paused');
    expect(last.node_id).toBe('t');
  });

  it('refuses if no active goal', () => {
    const root = setup(null, null);
    const result = pauseGoal(root);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/no active goal/i);
  });

  it('refuses if lifecycle is not pursuing', () => {
    const state = pursuingState();
    state.lifecycle = 'paused';
    const root = setup(sampleTree(), state);
    const result = pauseGoal(root);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/cannot pause/i);
  });
});

describe('resumeGoal', () => {
  it('transitions paused → pursuing and clears paused_at', () => {
    const state = pursuingState();
    state.lifecycle = 'paused';
    state.paused_at = '2026-05-09T01:00:00.000Z';
    const root = setup(sampleTree(), state);
    const result = resumeGoal(root);
    expect(result.ok).toBe(true);
    const newState = JSON.parse(fs.readFileSync(path.join(root, '.claude/goals/active/state.json'), 'utf8'));
    expect(newState.lifecycle).toBe('pursuing');
    expect(newState.paused_at).toBeNull();
    const last = newState.history[newState.history.length - 1];
    expect(last.event).toBe('resumed');
  });

  it('refuses if not paused', () => {
    const root = setup(sampleTree(), pursuingState());
    const result = resumeGoal(root);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/cannot resume/i);
  });

  it('refuses if iteration budget is exhausted', () => {
    const state = pursuingState();
    state.lifecycle = 'paused';
    state.budget.iterations.used = 100;
    state.budget.iterations.max = 100;
    const root = setup(sampleTree(), state);
    const result = resumeGoal(root);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/budget exhausted/i);
  });

  it('refuses if token budget is exhausted', () => {
    const state = pursuingState();
    state.lifecycle = 'paused';
    state.budget.tokens.used = 1_000_000;
    state.budget.tokens.max = 1_000_000;
    const root = setup(sampleTree(), state);
    const result = resumeGoal(root);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/budget exhausted/i);
  });

  it('refuses if wallclock budget is exhausted', () => {
    const state = pursuingState();
    state.lifecycle = 'paused';
    // started_at is over 4h ago; max_seconds is 1
    state.budget.wallclock.started_at = new Date(Date.now() - 5_000_000).toISOString();
    state.budget.wallclock.max_seconds = 1;
    const root = setup(sampleTree(), state);
    const result = resumeGoal(root);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/budget exhausted/i);
  });

  it('allows resume when max_seconds is 0 (infinite wallclock)', () => {
    const state = pursuingState();
    state.lifecycle = 'paused';
    state.budget.wallclock.max_seconds = 0;
    const root = setup(sampleTree(), state);
    const result = resumeGoal(root);
    expect(result.ok).toBe(true);
  });
});

describe('clearGoal', () => {
  it('removes the active dir', () => {
    const root = setup(sampleTree(), pursuingState());
    const result = clearGoal(root, { archive: false });
    expect(result.ok).toBe(true);
    expect(fs.existsSync(path.join(root, '.claude/goals/active'))).toBe(false);
  });

  it('archives before clearing when archive=true', () => {
    const root = setup(sampleTree(), pursuingState());
    const result = clearGoal(root, { archive: true });
    expect(result.ok).toBe(true);
    expect(result.archivedTo).toBeTruthy();
    expect(fs.existsSync(result.archivedTo)).toBe(true);
    // Archive should contain the original tree.json + state.json.
    expect(fs.existsSync(path.join(result.archivedTo, 'tree.json'))).toBe(true);
    expect(fs.existsSync(path.join(result.archivedTo, 'state.json'))).toBe(true);
    // Active dir is gone.
    expect(fs.existsSync(path.join(root, '.claude/goals/active'))).toBe(false);
  });

  it('returns ok=true noop when no active goal', () => {
    const root = setup(null, null);
    const result = clearGoal(root, { archive: false });
    expect(result.ok).toBe(true);
    expect(result.noop).toBe(true);
  });
});

describe('abandonGoal', () => {
  it('marks lifecycle unmet with reason', () => {
    const root = setup(sampleTree(), pursuingState());
    const result = abandonGoal(root, { reason: 'changed mind' });
    expect(result.ok).toBe(true);
    const state = JSON.parse(fs.readFileSync(path.join(root, '.claude/goals/active/state.json'), 'utf8'));
    expect(state.lifecycle).toBe('unmet');
    expect(state.ended_reason).toBe('changed mind');
    expect(state.ended_at).toBeTruthy();
    const last = state.history[state.history.length - 1];
    expect(last.event).toBe('unmet');
    expect(last.payload.reason).toBe('changed mind');
  });

  it('refuses if no active goal', () => {
    const root = setup(null, null);
    const result = abandonGoal(root, { reason: 'x' });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/no active goal/i);
  });

  it('uses default reason when none provided', () => {
    const root = setup(sampleTree(), pursuingState());
    const result = abandonGoal(root, {});
    expect(result.ok).toBe(true);
    const state = JSON.parse(fs.readFileSync(path.join(root, '.claude/goals/active/state.json'), 'utf8'));
    expect(state.ended_reason).toBe('manual abandon');
  });
});
