#!/usr/bin/env node
/**
 * /goal-mode:goal-tree CLI — render the active goal plan as ASCII tree.
 */
import { loadState, loadTree } from './state.mjs';
import { renderTree } from './goal-tree.mjs';

const projectRoot = process.cwd();
const tree = loadTree(projectRoot);
const state = loadState(projectRoot);
if (!tree) {
  process.stderr.write('❌ No active plan in this project (tree.json missing).\n');
  process.stderr.write('   Run /goal-mode:goal-plan-from-file <path> or /goal-mode:goal-plan "<mission>" to bootstrap.\n');
  process.exit(1);
}
const cursorId = state?.cursor ?? null;
process.stdout.write(renderTree(tree, cursorId) + '\n');
process.exit(0);
