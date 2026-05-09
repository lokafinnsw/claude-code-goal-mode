/**
 * Pure plan-tree validator for /goal:approve-plan.
 *
 * Function: validatePlan(tree, opts?) → { ok, errors, warnings }
 *
 * Inputs:
 *   - tree: a candidate goal-tree (any shape; first checked against zod
 *     GoalTreeSchema, then against business rules).
 *   - opts.availableReviewers: optional Set<string> of subagent_type
 *     names known to be installed in the current environment. When
 *     provided, every node.review[] entry not in the set produces a
 *     WARNING (not an error). When NOT provided (e.g. CLI ran with
 *     reviewer-discovery disabled), no review-availability check runs.
 *
 * Returns:
 *   - ok: false if ANY error fired; true otherwise.
 *   - errors: array of human-readable error strings (block approval).
 *   - warnings: array of human-readable warning strings (printed but
 *     do not block approval).
 *
 * Validation steps (in order):
 *   1. zod schema check via GoalTreeSchema.parse. Fast-fails on first
 *      schema error (returns {ok:false, errors:[...]}, warnings:[]).
 *   2. Recursive descent through the tree, checking each node for:
 *      - title / goal / acceptance_criteria entries containing
 *        placeholder tokens (TBD / TODO / FIXME / XXX / ??? — case
 *        insensitive, word-bounded for first 4).
 *      - tasks (type === 'task') with empty acceptance_criteria[] —
 *        rejected as the engine cannot produce an "achieved" verdict
 *        for a zero-criteria task.
 *      - review[] entries not in opts.availableReviewers (when
 *        provided) — emit a WARNING per missing reviewer.
 *
 * Pure: no I/O, no globals.
 */

import { GoalTreeSchema } from './state.mjs';

// Word-bounded for the first 4 alphabetic tokens; '???' is matched
// unanchored because '?' is not a \w char and \b around it would never
// hold against typical surrounding whitespace/punctuation. This honors
// the docstring contract ("word-bounded for first 4") rather than the
// plan source's literal regex (which combined them under a single \b
// pair and would silently miss '???').
const PLACEHOLDER_RE = /\b(TBD|TODO|FIXME|XXX)\b|\?{3,}/i;

export function validatePlan(tree, opts = {}) {
  const errors = [];
  const warnings = [];

  try {
    GoalTreeSchema.parse(tree);
  } catch (e) {
    errors.push(`schema: ${e.message}`);
    return { ok: false, errors, warnings };
  }

  function check(node) {
    for (const field of ['title', 'goal']) {
      if (PLACEHOLDER_RE.test(node[field])) {
        errors.push(`node ${node.id}: ${field} contains placeholder (${node[field]})`);
      }
    }
    for (const c of node.acceptance_criteria) {
      if (PLACEHOLDER_RE.test(c)) {
        errors.push(`node ${node.id}: criterion contains placeholder (${c})`);
      }
    }
    if (node.type === 'task' && node.acceptance_criteria.length === 0) {
      errors.push(`node ${node.id}: task has no acceptance_criteria`);
    }
    if (opts.availableReviewers) {
      for (const r of node.review) {
        if (!opts.availableReviewers.has(r)) {
          warnings.push(`node ${node.id}: reviewer "${r}" not available in current environment`);
        }
      }
    }
    for (const child of node.children) check(child);
  }

  check(tree.root);
  return { ok: errors.length === 0, errors, warnings };
}
