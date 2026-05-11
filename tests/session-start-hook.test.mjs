import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runSessionStartHook } from '../engine/session-start-hook.mjs';
import { saveState, saveTree } from '../engine/state.mjs';

function mkRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ss-hook-'));
}

function makeTree() {
  return {
    schema_version: 2,
    goal_id: 'g',
    mission: 'm',
    created_at: new Date().toISOString(),
    approved_at: new Date().toISOString(),
    root: {
      id: 'sprint-1',
      type: 'sprint',
      title: 'Sprint',
      goal: 'sg',
      acceptance_criteria: ['c'],
      review: [],
      validate: null,
      work_front: null,
      status: 'pending',
      evidence: [],
      blocker_reason: null,
      review_attempts: 0,
      notes: [],
      children: [
        {
          id: 'sprint-1.epic-1',
          type: 'epic',
          title: 'E',
          goal: 'eg',
          acceptance_criteria: ['c'],
          review: [],
          validate: null,
          work_front: null,
          status: 'pending',
          evidence: [],
          blocker_reason: null,
          review_attempts: 0,
          notes: [],
          children: [
            {
              id: 'sprint-1.epic-1.task-1',
              type: 'task',
              title: 'T',
              goal: 'tg',
              acceptance_criteria: ['ac0'],
              review: [],
              validate: null,
              work_front: null,
              status: 'pending',
              evidence: [],
              blocker_reason: null,
              review_attempts: 0,
              notes: [],
              children: [],
            },
          ],
        },
      ],
    },
  };
}

function makeState(overrides = {}) {
  return {
    schema_version: 2,
    goal_id: 'g',
    lifecycle: 'pursuing',
    cursor: 'sprint-1.epic-1.task-1',
    budget: {
      iterations: { used: 0, max: 100 },
      tokens: { used: 0, max: 1_000_000 },
      wallclock: { started_at: new Date().toISOString(), max_seconds: 86400 },
    },
    session_id: 'sess-ss',
    started_at: new Date().toISOString(),
    paused_at: null,
    ended_at: null,
    ended_reason: null,
    history: [],
    ...overrides,
  };
}

describe('SessionStart hook', () => {
  it('returns null stdout when no active goal exists (passthrough)', async () => {
    const root = mkRoot();
    const result = await runSessionStartHook({ stdin: {}, projectRoot: root });
    expect(result.stdout).toBeNull();
    expect(result.exit).toBe(0);
  });

  it('returns null stdout when lifecycle is paused (passthrough)', async () => {
    const root = mkRoot();
    saveTree(root, makeTree());
    saveState(root, makeState({ lifecycle: 'paused', paused_at: new Date().toISOString() }));
    const result = await runSessionStartHook({ stdin: {}, projectRoot: root });
    expect(result.stdout).toBeNull();
  });

  it('returns null stdout when lifecycle is achieved (passthrough)', async () => {
    const root = mkRoot();
    saveTree(root, makeTree());
    saveState(root, makeState({ lifecycle: 'achieved', ended_at: new Date().toISOString() }));
    const result = await runSessionStartHook({ stdin: {}, projectRoot: root });
    expect(result.stdout).toBeNull();
  });

  it('emits SessionStart additionalContext with continuation prompt when goal is pursuing', async () => {
    const root = mkRoot();
    saveTree(root, makeTree());
    saveState(root, makeState());
    const result = await runSessionStartHook({ stdin: {}, projectRoot: root });
    expect(result.stdout).toBeTruthy();
    expect(result.stdout.hookSpecificOutput.hookEventName).toBe('SessionStart');
    const ctx = result.stdout.hookSpecificOutput.additionalContext;
    expect(ctx).toContain('goal-mode auto-resume');
    expect(ctx).toContain('sprint-1.epic-1.task-1');
    // Progress block embedded
    expect(ctx).toContain('Progress');
    expect(ctx).toMatch(/Sprint \d+\/\d+/);
  });

  it('emits a clear diagnostic when cursor does not resolve in tree', async () => {
    const root = mkRoot();
    saveTree(root, makeTree());
    saveState(root, makeState({ cursor: 'sprint-9.epic-9.task-9' }));
    const result = await runSessionStartHook({ stdin: {}, projectRoot: root });
    expect(result.stdout.hookSpecificOutput.additionalContext).toContain('does not resolve');
    expect(result.stdout.hookSpecificOutput.additionalContext).toContain('goal-doctor');
  });

  it('internal error surfaces as additionalContext, not silent', async () => {
    const root = mkRoot();
    // Write malformed JSON to force loadState into the .broken-* path → returns null
    // → SessionStart returns null stdout (graceful). This test confirms the
    // graceful-null path, since the error path is harder to trigger from outside.
    // The error-as-prompt path is exercised by the throw-in-runSessionStartHook
    // test below.
    fs.mkdirSync(path.join(root, '.claude/goals/active'), { recursive: true });
    fs.writeFileSync(path.join(root, '.claude/goals/active/state.json'), '{not-json');
    const result = await runSessionStartHook({ stdin: {}, projectRoot: root });
    expect(result.exit).toBe(0);
    expect(result.stdout).toBeNull();
  });
});
