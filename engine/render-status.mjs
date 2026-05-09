/**
 * Render the goal-status report for /goal:status.
 *
 * Function: renderStatus(tree, state, now? = Date.now()): string
 *
 * Output sections:
 *   - Heading: goal id + current lifecycle.
 *   - Plan tree: indented DFS with status-icon prefix and ◀ cursor mark.
 *   - Budget: iteration / token / wallclock progress bars (∞ for max=0).
 *   - Last 3 events: from state.history tail.
 *
 * Pure given fixed now. Status icons via the ICON map. Wallclock minutes
 * derived from (now - wallclock.started_at) as in continuation.mjs's
 * buildContext, with the same 0-clamp on clock skew.
 */

import { wallclockMinutes } from './wallclock.mjs';

const ICON = {
  pending: '⬜',
  pursuing: '🟡',
  'review-pending': '🔵',
  achieved: '✅',
  blocked: '⛔',
  skipped: '⏭',
};

function bar(used, max, width = 20) {
  if (max === 0) return '∞';
  const pct = Math.min(1, used / max);
  const filled = Math.round(pct * width);
  return '[' + '█'.repeat(filled) + '·'.repeat(width - filled) + `] ${used}/${max}`;
}

export function renderStatus(tree, state, now = Date.now()) {
  const lines = [];
  lines.push(`# 🎯 Goal: ${tree.goal_id} — lifecycle: ${state.lifecycle}`);
  lines.push('');
  lines.push('## Plan tree');
  function visit(node, depth) {
    const indent = '  '.repeat(depth);
    const icon = ICON[node.status] ?? '?';
    const cursorMark = state.cursor === node.id ? ' ◀ cursor' : '';
    lines.push(`${indent}${icon} ${node.id}${cursorMark} — ${node.title}`);
    for (const c of node.children) visit(c, depth + 1);
  }
  visit(tree.root, 0);
  lines.push('');
  lines.push('## Budget');
  lines.push(`- Iterations: ${bar(state.budget.iterations.used, state.budget.iterations.max)}`);
  lines.push(`- Tokens: ${bar(state.budget.tokens.used, state.budget.tokens.max)}`);
  const elapsed = wallclockMinutes(state, now);
  const maxMin = Math.floor(state.budget.wallclock.max_seconds / 60);
  lines.push(`- Wall-clock: ${bar(elapsed, maxMin)} minutes`);
  lines.push('');
  lines.push('## Last 3 events');
  for (const h of state.history.slice(-3)) {
    lines.push(`- ${h.ts} ${h.event} ${h.node_id ?? ''}`);
  }
  return lines.join('\n');
}
