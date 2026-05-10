/**
 * Initialize the active-goal state from an approved tree.json.
 *
 * Function: startGoal(projectRoot, opts) → { ok, cursor? , error? }
 *
 * Inputs:
 *   - projectRoot: absolute path of the user's Claude Code project (cwd
 *           of the user's session). Tree must already exist at
 *           {projectRoot}/.claude/goals/active/tree.json.
 *   - opts.sessionId: the Claude Code session id (passed from
 *           CLAUDE_CODE_SESSION_ID env in the CLI wrapper). Pinned in
 *           state.session_id so only this session drives the goal.
 *   - opts.maxIter: triple-budget iteration cap.
 *   - opts.tokenBudget: triple-budget token cap.
 *   - opts.timeBudgetSeconds: triple-budget wallclock cap.
 *
 * Returns:
 *   - { ok: true, cursor: <node_id> } when state.json was written.
 *   - { ok: false, error: <reason> } if any precondition failed:
 *       no tree.json, tree not approved, no pending tasks.
 *
 * Pre-conditions verified (each surfaces a distinct error):
 *   1. tree.json exists at {projectRoot}/.claude/goals/active/tree.json.
 *   2. tree.approved_at is non-null (Phase-6 /goal:approve-plan sets it).
 *   3. At least one leaf task has status 'pending' (the cursor target).
 *
 * Side effects: writes .claude/goals/active/state.json (atomic).
 *
 * Composition: loadTree (Phase 1), walkLeafTasks (Phase 1), saveState (Phase 1).
 */

import { loadTree, loadState, saveState } from './state.mjs';
import { walkLeafTasks } from './traversal.mjs';

export function startGoal(projectRoot, { sessionId, maxIter, tokenBudget, timeBudgetSeconds, force = false }) {
  const tree = loadTree(projectRoot);
  if (!tree) return { ok: false, error: 'no goal tree found; run /goal:plan first' };
  if (!tree.approved_at) return { ok: false, error: 'tree not approved; run /goal:approve-plan' };
  const existingState = loadState(projectRoot);
  // RESTARTABLE_LIFECYCLES are pre-pursuit states that the canonical workflow
  // (`/goal:plan` → `/goal:approve-plan` → `/goal:start`) writes BEFORE the
  // user calls /goal:start. Overwriting them is the documented happy path,
  // not an "active goal already exists" footgun. Other lifecycles (pursuing,
  // paused, achieved, unmet, budget-limited) require explicit --force, since
  // overwriting would lose mid-flight or terminal state.
  const RESTARTABLE_LIFECYCLES = new Set(['draft', 'approved']);
  if (existingState && !force && !RESTARTABLE_LIFECYCLES.has(existingState.lifecycle)) {
    return {
      ok: false,
      error: `goal already active (lifecycle=${existingState.lifecycle}, cursor=${existingState.cursor}); use --force to restart`,
    };
  }
  const tasks = walkLeafTasks(tree);
  const firstActive = tasks.find(t => t.status === 'pending' || t.status === 'pursuing');
  if (!firstActive) return { ok: false, error: 'no pending or pursuing tasks in tree' };
  const now = new Date().toISOString();
  const state = {
    schema_version: 1,
    goal_id: tree.goal_id,
    lifecycle: 'pursuing',
    cursor: firstActive.id,
    budget: {
      iterations: { used: 0, max: maxIter },
      tokens: { used: 0, max: tokenBudget },
      wallclock: { started_at: now, max_seconds: timeBudgetSeconds },
    },
    session_id: sessionId,
    started_at: now,
    paused_at: null,
    ended_at: null,
    ended_reason: null,
    history: [
      {
        ts: now,
        iteration: 0,
        event: 'started',
        node_id: firstActive.id,
        payload: { maxIter, tokenBudget, timeBudgetSeconds },
      },
    ],
  };
  saveState(projectRoot, state);
  return { ok: true, cursor: firstActive.id };
}
