/**
 * Pure-function core of /goal-mode:review-request.
 *
 * Read-only inspector. Returns the reviewer list and the audit-instructions
 * template body for the current cursor task (which must be in
 * review-pending status). The CLI consumer prints this so the agent
 * knows exactly which subagent_types to dispatch and what prompt to
 * pass to each.
 *
 * Does NOT mutate state — the cursor is already in review-pending
 * (typically set by /goal-mode:achieve when reviewers are required).
 *
 * Returns:
 *   - { ok: true, cursor, reviewers, task: { title, goal, acceptance_criteria },
 *       evidence_summary, validate, template }
 *   - { ok: false, error }   on any precondition failure
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTree, loadState } from './state.mjs';
import { findNodeById } from './traversal.mjs';

function readAuditInstructions() {
  // engine/review-request.mjs → ../prompts/audit-instructions.md
  const here = path.dirname(fileURLToPath(import.meta.url));
  const p = path.join(here, '..', 'prompts', 'audit-instructions.md');
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return '';
  }
}

export function reviewRequest(projectRoot) {
  const state = loadState(projectRoot);
  if (!state) return { ok: false, error: 'No active goal.' };
  if (state.lifecycle !== 'pursuing') {
    return { ok: false, error: `cannot request review from lifecycle=${state.lifecycle}` };
  }
  const tree = loadTree(projectRoot);
  if (!tree) return { ok: false, error: 'no tree.json found' };
  const cursor = findNodeById(tree, state.cursor);
  if (!cursor) return { ok: false, error: `cursor ${state.cursor} not found in tree` };
  if (cursor.status !== 'review-pending') {
    return { ok: false, error: `cursor not review-pending (is ${cursor.status})` };
  }
  if (!cursor.review.length) {
    return { ok: false, error: 'cursor has no required reviewers' };
  }

  const evidenceSummary = cursor.evidence.map((ev, i) => ({
    n: i,
    criterion: ev.criterion_index,
    file: ev.file,
    line: ev.line,
    command: ev.command,
    exit_code: ev.exit_code,
    note: ev.note,
  }));

  return {
    ok: true,
    cursor: cursor.id,
    reviewers: [...cursor.review],
    task: {
      title: cursor.title,
      goal: cursor.goal,
      acceptance_criteria: cursor.acceptance_criteria,
    },
    evidence_summary: evidenceSummary,
    validate: cursor.validate,
    template: readAuditInstructions(),
  };
}

export function formatReviewRequest(r) {
  if (!r.ok) return `❌ ${r.error}`;
  const lines = [
    `Review required for task ${r.cursor} (${r.task.title})`,
    `Goal: ${r.task.goal}`,
    '',
    'Reviewers to dispatch:',
    ...r.reviewers.map(a => `  - ${a}`),
    '',
    'Acceptance criteria:',
    ...r.task.acceptance_criteria.map((c, i) => `  (#${i}) ${c}`),
    '',
    `Evidence collected (${r.evidence_summary.length} items):`,
    ...r.evidence_summary.map(e => {
      const where = e.file ? `${e.file}${e.line ? ':' + e.line : ''}` : e.command || '?';
      return `  #${e.n} criterion=${e.criterion} ${where} — ${e.note || '(no note)'}`;
    }),
  ];
  if (r.validate) {
    lines.push('', `Validation command: ${r.validate}`);
  }
  lines.push('', 'Workflow:');
  lines.push('  1. For each reviewer above, dispatch via Agent({subagent_type: <name>, ...}) with the audit-instructions template (see below).');
  lines.push('  2. Collect each verdict text.');
  lines.push('  3. Call /goal-mode:goal-submit-verdict --agent <name> --status GO|NOGO|REVISE --text "<reason>" for each verdict.');
  if (r.template) {
    lines.push('', '--- audit-instructions template ---', r.template);
  }
  return lines.join('\n');
}
