/**
 * Pure-function cores for the four lifecycle slash commands:
 * /goal:pause, /goal:resume, /goal:clear, /goal:abandon.
 *
 * Each function takes (projectRoot, opts) and returns { ok, error? } plus
 * function-specific extras. They are pure with respect to JS state — they
 * read/write disk via state.mjs and the fs module, but do not maintain
 * in-memory state across calls.
 *
 * All functions:
 *   - Read state.json (or tree.json for clearGoal --archive) from
 *     {projectRoot}/.claude/goals/active/.
 *   - Mutate state, save atomically via saveState.
 *   - Append a history entry for traceability.
 *
 * Lifecycle transitions:
 *   - pauseGoal: pursuing → paused (records paused_at).
 *   - resumeGoal: paused → pursuing, refuses if any of the triple budget
 *     is already exhausted (matches the budget-limit semantics from
 *     applyMutations and stop-hook).
 *   - clearGoal: removes .claude/goals/active/ (optionally archives first).
 *   - abandonGoal: pursuing|paused → unmet (refuses other lifecycles to preserve terminal state)
 *
 * CLI wrappers in engine/pause-resume-cli.mjs, engine/clear-cli.mjs,
 * engine/abandon-cli.mjs are thin I/O shells; this module is fully
 * unit-tested.
 */

import fs from 'node:fs';
import path from 'node:path';
import { loadState, loadTree, saveState } from './state.mjs';
import { activeDir, archiveDir } from './paths.mjs';

/**
 * Pause an active (pursuing) goal. Records paused_at and appends a
 * 'paused' history event. Refuses unless lifecycle === 'pursuing'.
 */
export function pauseGoal(projectRoot) {
  const state = loadState(projectRoot);
  if (!state) return { ok: false, error: 'no active goal' };
  if (state.lifecycle !== 'pursuing') {
    return { ok: false, error: `cannot pause from lifecycle=${state.lifecycle}` };
  }
  const now = new Date().toISOString();
  state.lifecycle = 'paused';
  state.paused_at = now;
  state.history.push({
    ts: now,
    iteration: state.budget.iterations.used,
    event: 'paused',
    node_id: state.cursor,
    payload: {},
  });
  saveState(projectRoot, state);
  return { ok: true };
}

/**
 * Resume a paused goal. Refuses if any leg of the triple budget is
 * already exhausted (max=0 means "infinite", never exhausted, matching
 * applyMutations + stop-hook semantics). Clears paused_at and appends
 * a 'resumed' history event.
 */
export function resumeGoal(projectRoot) {
  const state = loadState(projectRoot);
  if (!state) return { ok: false, error: 'no active goal' };
  if (state.lifecycle !== 'paused') {
    return { ok: false, error: `cannot resume from lifecycle=${state.lifecycle}` };
  }
  // Refuse if any budget is exhausted (max=0 means "infinite", never exhausted).
  const iterDone = state.budget.iterations.max > 0
    && state.budget.iterations.used >= state.budget.iterations.max;
  const tokDone = state.budget.tokens.max > 0
    && state.budget.tokens.used >= state.budget.tokens.max;
  const elapsed = (Date.now() - new Date(state.budget.wallclock.started_at).getTime()) / 1000;
  const wallDone = state.budget.wallclock.max_seconds > 0
    && elapsed >= state.budget.wallclock.max_seconds;
  if (iterDone || tokDone || wallDone) {
    return { ok: false, error: 'budget exhausted; cannot resume' };
  }
  const now = new Date().toISOString();
  state.lifecycle = 'pursuing';
  state.paused_at = null;
  state.history.push({
    ts: now,
    iteration: state.budget.iterations.used,
    event: 'resumed',
    node_id: state.cursor,
    payload: {},
  });
  saveState(projectRoot, state);
  return { ok: true };
}

/**
 * Clear (delete) the active goal directory. If archive=true, copy
 * tree.json + state.json into .claude/goals/archive/<YYYY-MM-DD>-<slug>/
 * before removing. Returns { ok: true, noop: true } if there is nothing
 * to clear.
 */
export function clearGoal(projectRoot, { archive = false } = {}) {
  const adir = activeDir(projectRoot);
  if (!fs.existsSync(adir)) return { ok: true, noop: true };
  let archivedTo = null;
  if (archive) {
    const tree = loadTree(projectRoot);
    const slug = tree?.goal_id ?? 'unknown';
    // Full ISO timestamp (with `:` and `.` replaced for filesystem safety) so
    // each clear gets a unique archive — same-day, same-goal_id second clear
    // would otherwise overwrite the prior archive.
    const isoSafe = new Date().toISOString().replace(/[:.]/g, '-');
    archivedTo = path.join(archiveDir(projectRoot), `${isoSafe}-${slug}`);
    fs.mkdirSync(archivedTo, { recursive: true });
    fs.cpSync(adir, archivedTo, { recursive: true });
  }
  fs.rmSync(adir, { recursive: true, force: true });
  return { ok: true, archivedTo };
}

/**
 * Mark an active goal as 'unmet' (manual abandon). Records ended_at +
 * ended_reason and appends an 'unmet' history event with the reason in
 * payload. Default reason is "manual abandon".
 *
 * Refuses unless lifecycle is 'pursuing' or 'paused' — prevents silently
 * destroying ended_at / ended_reason on already-terminal states (achieved,
 * unmet) or transitioning out of pre-pursuit states (draft).
 */
const ABANDONABLE_LIFECYCLES = new Set(['pursuing', 'paused']);

export function abandonGoal(projectRoot, { reason = 'manual abandon' } = {}) {
  const state = loadState(projectRoot);
  if (!state) return { ok: false, error: 'no active goal' };
  if (!ABANDONABLE_LIFECYCLES.has(state.lifecycle)) {
    return { ok: false, error: `cannot abandon from lifecycle=${state.lifecycle}` };
  }
  const now = new Date().toISOString();
  state.lifecycle = 'unmet';
  state.ended_at = now;
  state.ended_reason = reason;
  state.history.push({
    ts: now,
    iteration: state.budget.iterations.used,
    event: 'unmet',
    node_id: state.cursor,
    payload: { reason },
  });
  saveState(projectRoot, state);
  return { ok: true };
}
