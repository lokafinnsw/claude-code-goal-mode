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

// CLI entry — guarded so tests can `import` this file and call discoverReviewers
// in isolation without triggering the side effects.
if (import.meta.url === `file://${process.argv[1]}`) {
  const tree = loadTree(process.cwd());
  if (!tree) {
    console.error('no tree.json; run /goal:plan first');
    process.exit(1);
  }
  const result = validatePlan(tree, { availableReviewers: discoverReviewers() });
  if (result.warnings.length) {
    console.log('⚠️  warnings:');
    for (const w of result.warnings) console.log('  - ' + w);
  }
  if (!result.ok) {
    console.error('❌ validation failed:');
    for (const e of result.errors) console.error('  - ' + e);
    process.exit(1);
  }
  tree.approved_at = new Date().toISOString();
  saveTree(process.cwd(), tree);

  let state = loadState(process.cwd());
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
  saveState(process.cwd(), state);
  console.log(`✅ plan approved (${countTasks(tree.root)} tasks)`);
}
