/**
 * Tests for engine/hook-context.mjs (v2.0.3 shared hook plumbing).
 *
 * Coverage:
 *   - hasActiveGoal: true iff state.json exists; false on missing dir.
 *   - resolvePluginRoot: honors CLAUDE_PLUGIN_ROOT; otherwise resolves
 *     relative to the calling module's URL via fileURLToPath (Windows-safe).
 *   - enrichContinuationContext:
 *       * for continuation-review.md adds audit_instructions,
 *         rejected_verdicts, has_rejected_verdicts.
 *       * for continuation-blocked.md adds uncovered_criteria,
 *         last_verdicts (deduped), and unavailable_reviewers* when the
 *         most recent node-blocked event has escape_hatch=true.
 *       * rotation-resilient fallback: extracts unavailable_reviewers from
 *         cursor.blocker_reason substring when history is empty (bug I4).
 *       * for continuation.md (no enrichment), ctx is left as-is.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  enrichContinuationContext,
  hasActiveGoal,
  hasActiveGoalAndTree,
  resolvePluginRoot,
  readPromptFile,
} from '../engine/hook-context.mjs';
import { activeDir, statePath, treePath } from '../engine/paths.mjs';

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-hookctx-'));
  return root;
}

describe('hook-context: hasActiveGoal precheck', () => {
  it('returns false when project has no .claude dir at all', () => {
    const root = setup();
    expect(hasActiveGoal(root)).toBe(false);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('returns false when .claude/goals/active exists but state.json missing', () => {
    const root = setup();
    fs.mkdirSync(activeDir(root), { recursive: true });
    expect(hasActiveGoal(root)).toBe(false);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('returns true when state.json exists', () => {
    const root = setup();
    fs.mkdirSync(activeDir(root), { recursive: true });
    fs.writeFileSync(statePath(root), '{}');
    expect(hasActiveGoal(root)).toBe(true);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('hasActiveGoalAndTree requires BOTH state and tree files', () => {
    const root = setup();
    fs.mkdirSync(activeDir(root), { recursive: true });
    fs.writeFileSync(statePath(root), '{}');
    expect(hasActiveGoalAndTree(root)).toBe(false);
    fs.writeFileSync(treePath(root), '{}');
    expect(hasActiveGoalAndTree(root)).toBe(true);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('hook-context: resolvePluginRoot', () => {
  it('honors CLAUDE_PLUGIN_ROOT when set', () => {
    const orig = process.env.CLAUDE_PLUGIN_ROOT;
    process.env.CLAUDE_PLUGIN_ROOT = '/some/override';
    try {
      expect(resolvePluginRoot(import.meta.url)).toBe('/some/override');
    } finally {
      if (orig === undefined) delete process.env.CLAUDE_PLUGIN_ROOT;
      else process.env.CLAUDE_PLUGIN_ROOT = orig;
    }
  });

  it('falls back to ../ of import.meta.url when env unset', () => {
    const orig = process.env.CLAUDE_PLUGIN_ROOT;
    delete process.env.CLAUDE_PLUGIN_ROOT;
    try {
      const root = resolvePluginRoot(import.meta.url);
      // For this test file at <repo>/tests/hook-context.test.mjs, the parent
      // of `..` is the repo root. We just check it's an absolute path and
      // ends WITHOUT a `tests` segment.
      expect(path.isAbsolute(root)).toBe(true);
      expect(root.endsWith('tests')).toBe(false);
    } finally {
      if (orig === undefined) delete process.env.CLAUDE_PLUGIN_ROOT;
      else process.env.CLAUDE_PLUGIN_ROOT = orig;
    }
  });
});

describe('hook-context: enrichContinuationContext for review template', () => {
  function mkState(cursorId = 't', history = []) {
    return {
      schema_version: 2,
      goal_id: 'g',
      lifecycle: 'pursuing',
      cursor: cursorId,
      budget: { iterations: { used: 1, max: 100 }, tokens: { used: 0, max: 0 }, wallclock: { started_at: '2026-05-09T00:00:00.000Z', max_seconds: 0 } },
      session_id: 's',
      started_at: '2026-05-09T00:00:00.000Z',
      paused_at: null, ended_at: null, ended_reason: null,
      history,
    };
  }
  function mkCursor(id = 't', review = ['agent-1']) {
    return {
      id, type: 'task', title: 't', goal: 'g',
      acceptance_criteria: ['c0'],
      review, validate: null, work_front: null,
      status: 'review-pending',
      evidence: [],
      blocker_reason: null,
      review_attempts: 0,
      notes: [],
      children: [],
    };
  }

  it('adds rejected_verdicts and has_rejected_verdicts=true when verdicts exist', () => {
    const cursor = mkCursor();
    const state = mkState('t', [
      { ts: '2026-05-11T12:00:01.000Z', iteration: 1, event: 'review-verdict', node_id: 't', payload: { agent: 'agent-1', status: 'GO', rejected: true, reason: 'no dispatch' } },
    ]);
    const ctx = {};
    enrichContinuationContext(ctx, 'continuation-review.md', state, cursor, { pluginRoot: null });
    expect(ctx.rejected_verdicts).toHaveLength(1);
    expect(ctx.rejected_verdicts[0]).toMatchObject({ agent: 'agent-1', status: 'GO', reason: 'no dispatch' });
    expect(ctx.has_rejected_verdicts).toBe(true);
  });

  it('does not add audit_instructions when pluginRoot is null', () => {
    const cursor = mkCursor();
    const state = mkState();
    const ctx = {};
    enrichContinuationContext(ctx, 'continuation-review.md', state, cursor, { pluginRoot: null });
    expect(ctx.audit_instructions).toBeUndefined();
  });

  it('filters rejected_verdicts by lastCursorAdvanceTs', () => {
    const cursor = mkCursor();
    const state = mkState('t', [
      { ts: '2026-05-11T10:00:00.000Z', iteration: 1, event: 'review-verdict', node_id: 't', payload: { agent: 'old', status: 'GO', rejected: true } },
      { ts: '2026-05-11T11:00:00.000Z', iteration: 1, event: 'cursor-advanced', node_id: 't', payload: {} },
      { ts: '2026-05-11T12:00:00.000Z', iteration: 1, event: 'review-verdict', node_id: 't', payload: { agent: 'new', status: 'GO', rejected: true } },
    ]);
    const ctx = {};
    enrichContinuationContext(ctx, 'continuation-review.md', state, cursor, { pluginRoot: null });
    expect(ctx.rejected_verdicts).toHaveLength(1);
    expect(ctx.rejected_verdicts[0].agent).toBe('new');
  });

  it('has_rejected_verdicts=false on empty', () => {
    const cursor = mkCursor();
    const state = mkState();
    const ctx = {};
    enrichContinuationContext(ctx, 'continuation-review.md', state, cursor, { pluginRoot: null });
    expect(ctx.has_rejected_verdicts).toBe(false);
    expect(ctx.rejected_verdicts).toEqual([]);
  });
});

describe('hook-context: enrichContinuationContext for blocked template', () => {
  function mkBlockedCursor(blocker_reason = null) {
    return {
      id: 't', type: 'task', title: 't', goal: 'g',
      acceptance_criteria: ['c0', 'c1'],
      review: ['agent-1'], validate: null, work_front: null,
      status: 'blocked',
      evidence: [{ ts: '2026-05-11T12:00:00.000Z', iteration: 1, criterion_index: 0, file: 'a', line: null, commit: null, command: null, exit_code: null, note: 'n' }],
      blocker_reason,
      review_attempts: 1,
      notes: [],
      children: [],
    };
  }
  function mkState(history = []) {
    return {
      schema_version: 2,
      goal_id: 'g',
      lifecycle: 'pursuing',
      cursor: 't',
      budget: { iterations: { used: 5, max: 100 }, tokens: { used: 0, max: 0 }, wallclock: { started_at: '2026-05-09T00:00:00.000Z', max_seconds: 0 } },
      session_id: 's',
      started_at: '2026-05-09T00:00:00.000Z',
      paused_at: null, ended_at: null, ended_reason: null,
      history,
    };
  }

  it('extracts uncovered_criteria from ctx.criteria', () => {
    const cursor = mkBlockedCursor();
    const state = mkState();
    const ctx = {
      criteria: [
        { index: 0, text: 'c0', covered_marker: 'x' },
        { index: 1, text: 'c1', covered_marker: ' ' },
      ],
    };
    enrichContinuationContext(ctx, 'continuation-blocked.md', state, cursor, {});
    expect(ctx.uncovered_criteria).toEqual([{ index: 1, text: 'c1', covered_marker: ' ' }]);
  });

  it('deduplicates last_verdicts by (agent, status, text)', () => {
    const cursor = mkBlockedCursor();
    const state = mkState([
      { ts: '2026-05-11T12:00:00.000Z', iteration: 5, event: 'review-verdict', node_id: 't', payload: { agent: 'a', status: 'NOGO', text: 'fail' } },
      { ts: '2026-05-11T12:00:01.000Z', iteration: 5, event: 'review-verdict', node_id: 't', payload: { agent: 'a', status: 'NOGO', text: 'fail' } },
      { ts: '2026-05-11T12:00:02.000Z', iteration: 5, event: 'review-verdict', node_id: 't', payload: { agent: 'b', status: 'GO', text: 'ok' } },
    ]);
    const ctx = { criteria: [] };
    enrichContinuationContext(ctx, 'continuation-blocked.md', state, cursor, {});
    // last slice -1 = last 1, but dedupe applies on whatever made it in.
    // Tighter assertion: no duplicates by key in result.
    const keys = ctx.last_verdicts.map((v) => `${v.agent}|${v.status}|${v.text}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('extracts unavailable_reviewers from history when escape_hatch=true', () => {
    const cursor = mkBlockedCursor();
    const state = mkState([
      { ts: '2026-05-11T12:00:00.000Z', iteration: 5, event: 'review-verdict', node_id: 't', payload: { agent: 'aaa-art-director', status: 'REVISE', text: 'unavailable', escape_hatch: true } },
      { ts: '2026-05-11T12:00:01.000Z', iteration: 5, event: 'node-blocked', node_id: 't', payload: { reason: 'reviewer agent(s) unavailable in this environment: aaa-art-director.', escape_hatch: true } },
    ]);
    const ctx = { criteria: [] };
    enrichContinuationContext(ctx, 'continuation-blocked.md', state, cursor, {});
    expect(ctx.unavailable_reviewers).toEqual([{ agent: 'aaa-art-director' }]);
    expect(ctx.unavailable_reviewers_csv).toBe('aaa-art-director');
  });

  it('I4 fix: rotation-resilient — extracts agents from cursor.blocker_reason when history is empty', () => {
    const cursor = mkBlockedCursor(
      'reviewer agent(s) unavailable in this environment: aaa-art-director, rpg-game-designer. Run /goal-mode:goal-approve t to override.',
    );
    const state = mkState([]); // simulates fully-rotated history
    const ctx = { criteria: [] };
    enrichContinuationContext(ctx, 'continuation-blocked.md', state, cursor, {});
    expect(ctx.unavailable_reviewers).toEqual([
      { agent: 'aaa-art-director' },
      { agent: 'rpg-game-designer' },
    ]);
    expect(ctx.unavailable_reviewers_csv).toBe('aaa-art-director, rpg-game-designer');
  });

  it('blocker_reason without "unavailable" substring → no unavailable_reviewers', () => {
    const cursor = mkBlockedCursor('a different reason entirely');
    const state = mkState([]);
    const ctx = { criteria: [] };
    enrichContinuationContext(ctx, 'continuation-blocked.md', state, cursor, {});
    expect(ctx.unavailable_reviewers).toBeUndefined();
  });
});

describe('hook-context: enrichContinuationContext for continuation.md no-op', () => {
  it('does NOT add review/blocked fields when templateName is continuation.md', () => {
    const cursor = {
      id: 't', type: 'task', title: 't', goal: 'g',
      acceptance_criteria: ['c0'],
      review: [], validate: null, work_front: null,
      status: 'pursuing', evidence: [], blocker_reason: null, review_attempts: 0, notes: [], children: [],
    };
    const state = {
      schema_version: 2, goal_id: 'g', lifecycle: 'pursuing', cursor: 't',
      budget: { iterations: { used: 1, max: 100 }, tokens: { used: 0, max: 0 }, wallclock: { started_at: '2026-05-09T00:00:00.000Z', max_seconds: 0 } },
      session_id: 's', started_at: '2026-05-09T00:00:00.000Z', paused_at: null, ended_at: null, ended_reason: null, history: [],
    };
    const ctx = { foo: 'bar' };
    enrichContinuationContext(ctx, 'continuation.md', state, cursor, {});
    expect(ctx.rejected_verdicts).toBeUndefined();
    expect(ctx.uncovered_criteria).toBeUndefined();
    expect(ctx.unavailable_reviewers).toBeUndefined();
    expect(ctx.foo).toBe('bar');
  });
});
