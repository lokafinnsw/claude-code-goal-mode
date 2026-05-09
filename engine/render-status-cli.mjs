#!/usr/bin/env node
/**
 * /goal:status CLI wrapper.
 * Loads tree + state from cwd, renders, prints to stdout. Exits 0 even if
 * no goal active (just prints "no active goal" hint).
 */
import { loadTree, loadState } from './state.mjs';
import { renderStatus } from './render-status.mjs';

const tree = loadTree(process.cwd());
const state = loadState(process.cwd());
if (!tree || !state) {
  console.log('No active goal. Run /goal:plan to start.');
  process.exit(0);
}
console.log(renderStatus(tree, state));
