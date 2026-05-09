#!/usr/bin/env node
/**
 * /goal:approve-plan CLI wrapper.
 *
 * Behavior:
 *   1. Load tree.json from cwd's .claude/goals/active/.
 *   2. Discover available reviewers by listing `~/.claude/{skills,agents}/`
 *      and `<cwd>/.claude/{skills,agents}/` directories (per-environment
 *      installed skills + project-local agents).
 *   3. Run validatePlan(tree, { availableReviewers }).
 *   4. Print warnings (non-blocking) and errors (blocking).
 *   5. On success: stamp tree.approved_at = now ISO, save tree.
 *      Initialize state.json with lifecycle='approved' if missing, OR
 *      transition existing state.lifecycle to 'approved'.
 *      Append 'plan-approved' history event.
 *   6. Exit 0 on success, 1 on validation failure.
 *
 * C-1 lifecycle gate: refuses to transition if state.lifecycle is not in
 * {draft, approved}. This protects mid-run state from being clobbered if
 * /goal:approve-plan is invoked accidentally during pursuit.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadTree, saveTree, loadState, saveState } from './state.mjs';
import { validatePlan } from './validate-plan.mjs';

export function discoverReviewers(searchDirs = defaultSearchDirs()) {
  const out = new Set();
  for (const dir of searchDirs) {
    if (!fs.existsSync(dir)) continue;
    try {
      for (const name of fs.readdirSync(dir)) out.add(name);
    } catch (_) {
      // Permission denied or transient I/O — treat as empty dir.
    }
  }
  return out;
}

function defaultSearchDirs() {
  return [
    path.join(os.homedir(), '.claude', 'skills'),
    path.join(os.homedir(), '.claude', 'agents'),
    path.join(process.cwd(), '.claude', 'agents'),
    path.join(process.cwd(), '.claude', 'skills'),
  ];
}

function countTasks(node) {
  let n = node.type === 'task' ? 1 : 0;
  for (const c of node.children) n += countTasks(c);
  return n;
}

/**
 * Pure-ish core of /goal:approve-plan: reads tree.json from projectRoot,
 * runs validatePlan + reviewer discovery, on success stamps tree.approved_at
 * and transitions state.lifecycle (draft|approved → approved). Returns
 * { ok, errors, warnings, taskCount? }.
 *
 * Lifecycle gate (C-1 fix):
 *   - state missing → write fresh state.json with lifecycle='approved'.
 *   - state.lifecycle === 'draft' → transition to 'approved'.
 *   - state.lifecycle === 'approved' → idempotent re-stamp (allow user to
 *     edit + re-approve before /goal:start).
 *   - any other lifecycle → REFUSE with error; preserves the user's run.
 */
export function approvePlan(projectRoot, opts = {}) {
  const tree = loadTree(projectRoot);
  if (!tree) {
    return { ok: false, errors: ['no tree.json; run /goal:plan first'], warnings: [] };
  }
  const availableReviewers = opts.availableReviewers ?? discoverReviewers();
  const result = validatePlan(tree, { availableReviewers });
  if (!result.ok) {
    return { ok: false, errors: result.errors, warnings: result.warnings };
  }

  // C-1 lifecycle gate.
  const existingState = loadState(projectRoot);
  if (existingState && existingState.lifecycle !== 'draft' && existingState.lifecycle !== 'approved') {
    return {
      ok: false,
      errors: [
        `refusing to approve: state.lifecycle=${existingState.lifecycle}; ` +
        `/goal:approve-plan only valid from draft. Run /goal:clear --archive first if you want to re-approve.`,
      ],
      warnings: result.warnings,
    };
  }

  tree.approved_at = new Date().toISOString();
  saveTree(projectRoot, tree);

  let state = existingState;
  if (!state) {
    state = {
      schema_version: 1,
      goal_id: tree.goal_id,
      lifecycle: 'approved',
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
  } else {
    state.lifecycle = 'approved';
  }
  state.history.push({
    ts: tree.approved_at,
    iteration: 0,
    event: 'plan-approved',
    node_id: null,
    payload: {},
  });
  saveState(projectRoot, state);

  return { ok: true, errors: [], warnings: result.warnings, taskCount: countTasks(tree.root) };
}

// CLI entry — guarded so tests can `import` this file and call the exported
// helpers in isolation without triggering the side effects.
if (import.meta.url === `file://${process.argv[1]}`) {
  const result = approvePlan(process.cwd());
  if (result.warnings.length) {
    console.log('⚠️  warnings:');
    for (const w of result.warnings) console.log('  - ' + w);
  }
  if (!result.ok) {
    console.error('❌ ' + (result.errors.length === 1 ? result.errors[0] : 'validation failed:'));
    if (result.errors.length > 1) {
      for (const e of result.errors) console.error('  - ' + e);
    }
    process.exit(1);
  }
  console.log(`✅ plan approved (${result.taskCount} tasks)`);
}
