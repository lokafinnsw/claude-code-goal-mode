/**
 * Progress — derived view of plan completion.
 *
 * computeProgress(tree, cursorId) returns sprint/epic/task counters and
 * percentages, plus an ASCII progress block ready for inlining into a
 * continuation prompt. Pure function; no I/O, never throws on missing nodes.
 */

import { findNodeById } from './traversal.mjs';

const BAR_WIDTH = 10;

function bar(done, total) {
  if (total <= 0) return '░'.repeat(BAR_WIDTH);
  const filled = Math.round((done / total) * BAR_WIDTH);
  return '█'.repeat(filled) + '░'.repeat(BAR_WIDTH - filled);
}

function countByType(node, type) {
  let total = 0;
  let done = 0;
  function walk(n) {
    if (n.type === type) {
      total += 1;
      if (n.status === 'achieved') done += 1;
    }
    for (const c of n.children) walk(c);
  }
  walk(node);
  return { total, done };
}

function findAncestor(root, cursorId, ancestorType) {
  // Find the cursor node, then walk up the tree via traversal-by-prefix.
  // tree.json doesn't carry parent refs, so we resolve via id-prefix
  // matching: a task id "sprint-1.epic-7.task-4" has ancestor epic
  // "sprint-1.epic-7" and ancestor sprint "sprint-1".
  if (!cursorId) return null;
  const parts = cursorId.split('.');
  // Ancestor types in order: sprint (parts[0]), epic (parts[0..1]).
  if (ancestorType === 'sprint') {
    return findNodeById({ root }, parts[0]) ?? null;
  }
  if (ancestorType === 'epic' && parts.length >= 2) {
    return findNodeById({ root }, parts.slice(0, 2).join('.')) ?? null;
  }
  return null;
}

/**
 * computeProgress(tree, cursorId) → {
 *   sprint: { done, total, pct, title },
 *   epic:   { done, total, pct, title },  // within current sprint
 *   task:   { index, total, title },      // task position within current epic
 *   overall:{ done, total, pct },          // every task in the whole tree
 *   block:  string  // ready-to-embed ASCII multi-line progress block
 * }
 *
 * If cursorId points to a sprint or epic node (not a task), epic/task fields
 * fall back to whole-tree counts so the function never throws on missing context.
 */
export function computeProgress(tree, cursorId) {
  const root = tree?.root;
  if (!root) {
    return {
      sprint: { done: 0, total: 0, pct: 0, title: '' },
      epic: { done: 0, total: 0, pct: 0, title: '' },
      task: { index: 0, total: 0, title: '' },
      overall: { done: 0, total: 0, pct: 0 },
      block: '(no plan loaded)',
    };
  }

  const overall = countByType(root, 'task');
  const overallPct = overall.total > 0 ? Math.round((overall.done / overall.total) * 100) : 0;

  // "Done sprint" / "done epic" = every TASK descendant is achieved. The
  // engine does not auto-mark sprint/epic status, so we derive completeness
  // from the leaves.
  function deepTasksAllDone(n) {
    const c = countByType(n, 'task');
    return c.total > 0 && c.done === c.total;
  }

  const sprintCounts = countByType(root, 'sprint');
  let sprintsDone = 0;
  function walkSprints(n) {
    if (n.type === 'sprint' && deepTasksAllDone(n)) sprintsDone += 1;
    for (const c of n.children) walkSprints(c);
  }
  walkSprints(root);
  sprintsDone = Math.min(sprintsDone, sprintCounts.total);

  // Current sprint/epic ancestry via cursor id prefix.
  const sprintNode = findAncestor(root, cursorId, 'sprint') ?? root;
  const epicNode = findAncestor(root, cursorId, 'epic');

  // Within-sprint epic counters: total = epic children, done = epics whose
  // tasks are all achieved.
  const inSprintEpicTotal = sprintNode.children.filter((c) => c.type === 'epic').length;
  const inSprintEpicDone = sprintNode.children.filter(
    (c) => c.type === 'epic' && deepTasksAllDone(c),
  ).length;
  const inSprintEpics = { total: inSprintEpicTotal, done: inSprintEpicDone };

  // Within-epic task counters + cursor position.
  let taskTotal = 0;
  let taskIndex = 0;
  let cursorTitle = '';
  if (epicNode) {
    const tasks = epicNode.children.filter((c) => c.type === 'task');
    taskTotal = tasks.length;
    const idx = tasks.findIndex((t) => t.id === cursorId);
    taskIndex = idx === -1 ? 0 : idx + 1; // 1-indexed for display
    if (idx !== -1) cursorTitle = tasks[idx].title;
  } else {
    // Cursor on sprint/epic itself or no resolved ancestor — fall back to overall.
    taskTotal = overall.total;
    taskIndex = overall.done;
  }

  const sprintPct =
    sprintCounts.total > 0 ? Math.round((sprintsDone / sprintCounts.total) * 100) : 0;
  const epicPct =
    inSprintEpics.total > 0 ? Math.round((inSprintEpics.done / inSprintEpics.total) * 100) : 0;

  const lines = [];
  lines.push(
    `Sprint ${sprintsDone}/${sprintCounts.total}  ${bar(sprintsDone, sprintCounts.total)}  ${sprintPct}%${sprintNode?.title ? `  — ${sprintNode.title}` : ''}`,
  );
  lines.push(
    `Epic   ${inSprintEpics.done}/${inSprintEpics.total}  ${bar(inSprintEpics.done, inSprintEpics.total)}  ${epicPct}%${epicNode?.title ? `  — ${epicNode.title}` : ''}`,
  );
  lines.push(
    `Task   ${taskIndex}/${taskTotal}${cursorTitle ? `  on: ${cursorTitle}` : ''}`,
  );
  lines.push(`Overall ${overall.done}/${overall.total} tasks done · ${overallPct}%`);

  return {
    sprint: { done: sprintsDone, total: sprintCounts.total, pct: sprintPct, title: sprintNode?.title ?? '' },
    epic: { done: inSprintEpics.done, total: inSprintEpics.total, pct: epicPct, title: epicNode?.title ?? '' },
    task: { index: taskIndex, total: taskTotal, title: cursorTitle },
    overall: { done: overall.done, total: overall.total, pct: overallPct },
    block: lines.join('\n'),
  };
}
