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
 *      - review[] entries not in opts.availableReviewers (when
 *        provided) — emit a WARNING per missing reviewer.
 *
 *      Note: the empty-acceptance_criteria-on-task constraint is
 *      enforced at the schema layer (GoalNodeSchema.refine in
 *      state.mjs) and therefore short-circuits via the schema fast-fail
 *      above. No business-rule check is needed here.
 *
 * Pure: no I/O, no globals.
 */

import { GoalTreeSchema } from './state.mjs';
import { CURRENT_SCHEMA_VERSION, runMigrations } from './migrations.mjs';

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

  // Auto-migrate stale-schema input so callers (CLI commands, ad-hoc plan
  // validation, example-plans tests) can pass any tree the engine has ever
  // produced. Same contract as saveState/saveTree.
  let upgraded = tree;
  const fromVersion = tree?.schema_version;
  if (typeof fromVersion === 'number' && fromVersion < CURRENT_SCHEMA_VERSION) {
    const result = runMigrations(null, tree, fromVersion, CURRENT_SCHEMA_VERSION);
    if (result.error) {
      errors.push(`schema-migration: v${fromVersion}→v${CURRENT_SCHEMA_VERSION} failed: ${result.error}`);
      return { ok: false, errors, warnings };
    }
    upgraded = result.tree;
  }

  try {
    GoalTreeSchema.parse(upgraded);
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
    // Note: task nodes with empty acceptance_criteria are caught by
    // GoalNodeSchema's .refine() at the schema layer above, which fast-fails
    // before this business-rule pass runs. No duplicate check needed.
    if (opts.availableReviewers) {
      for (const r of node.review) {
        if (!opts.availableReviewers.has(r)) {
          warnings.push(`node ${node.id}: reviewer "${r}" not available in current environment`);
        }
      }
    }
    for (const child of node.children) check(child);
  }

  check(upgraded.root);
  return { ok: errors.length === 0, errors, warnings };
}
