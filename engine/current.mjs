/**
 * Pure-function core of /goal-mode:current — read-only cursor inspector.
 *
 * Returns a structured snapshot of the current cursor task with derived
 * fields (missing_criteria, evidence_count) suitable for both
 * human-readable display and built-in-/goal bridging.
 *
 * Returns:
 *   - { ok: true, lifecycle, cursor, task: { title, goal, status,
 *       acceptance_criteria, review, validate, work_front },
 *       evidence_count, missing_criteria }
 *   - { ok: false, error }   on any precondition failure
 *
 * Error messages match engine/manual-approve.mjs convention.
 *
 * Two formatter functions are exported alongside for the CLI:
 *   - formatHuman(r) → multiline string for terminal display
 *   - formatAsBuiltin(r) → single-line text suitable for piping into
 *     Claude Code's built-in /goal "<text>" command
 */
import { loadTree, loadState } from './state.mjs';
import { findNodeById } from './traversal.mjs';

export function currentTask(projectRoot) {
  const state = loadState(projectRoot);
  if (!state) return { ok: false, error: 'No active goal.' };
  const tree = loadTree(projectRoot);
  if (!tree) return { ok: false, error: 'no tree.json found' };
  const cursor = findNodeById(tree, state.cursor);
  if (!cursor) return { ok: false, error: `cursor ${state.cursor} not found in tree` };

  const covered = new Set();
  for (const ev of cursor.evidence) {
    if (ev.criterion_index !== null && ev.criterion_index >= 0 &&
        ev.criterion_index < cursor.acceptance_criteria.length) {
      covered.add(ev.criterion_index);
    }
  }
  const missing = [];
  for (let i = 0; i < cursor.acceptance_criteria.length; i++) {
    if (!covered.has(i)) missing.push(i);
  }
  return {
    ok: true,
    lifecycle: state.lifecycle,
    cursor: cursor.id,
    task: {
      title: cursor.title,
      goal: cursor.goal,
      status: cursor.status,
      acceptance_criteria: cursor.acceptance_criteria,
      review: cursor.review,
      validate: cursor.validate,
      work_front: cursor.work_front,
    },
    evidence_count: cursor.evidence.length,
    missing_criteria: missing,
  };
}

export function formatHuman(r) {
  if (!r.ok) return `❌ ${r.error}`;
  const lines = [
    `Task: ${r.task.title} (${r.cursor})`,
    `Status: ${r.task.status} · Lifecycle: ${r.lifecycle}`,
    `Goal: ${r.task.goal}`,
    'Acceptance criteria:',
    ...r.task.acceptance_criteria.map((c, i) =>
      `  ${r.missing_criteria.includes(i) ? '[ ]' : '[x]'} #${i} — ${c}`),
  ];
  if (r.task.review.length) lines.push(`Reviewers required: ${r.task.review.join(', ')}`);
  if (r.task.validate) lines.push(`Validate: ${r.task.validate}`);
  if (r.task.work_front) lines.push(`Work front: ${r.task.work_front}`);
  lines.push(`Evidence collected: ${r.evidence_count}`);
  return lines.join('\n');
}

export function formatAsBuiltin(r) {
  if (!r.ok) return '';
  const acStr = r.task.acceptance_criteria
    .map((c, i) => `(#${i}) ${c}`).join('; ');
  return `Goal: ${r.task.goal}. Acceptance: ${acStr}. ` +
    `Stop when all criteria have file/line evidence. ` +
    `Run /goal-mode:evidence-add per criterion, then /goal-mode:achieve.`;
}
