/**
 * Render the active plan tree as ASCII with status glyphs.
 *
 * Output shape:
 *   sprint-1 ▶ goal-mode v1.2.1 stability pass
 *   ├─ sprint-1.epic-1 ✓ Health diagnostics — /goal-doctor
 *   │  ├─ sprint-1.epic-1.task-1 ✓ defineDiagnosticCheckInterface
 *   │  └─ sprint-1.epic-1.task-2 ✓ implementDoctorEngineModule
 *   ├─ sprint-1.epic-2 ✓ Schema migrations
 *   │  └─ ...
 *   └─ sprint-1.epic-6 ▶ Integration & landing
 *      ├─ sprint-1.epic-6.task-1 ▶ bumpV1_2_1 (CURSOR)
 *      └─ sprint-1.epic-6.task-2 · updateReadme
 *
 * Glyphs (consistent with continuation prompts and CHANGELOG):
 *   ✓ achieved   ▶ pursuing   🔵 review-pending   ⛔ blocked   · pending
 *
 * For sprint/epic nodes (which the engine doesn't auto-set status on), the
 * displayed glyph is derived: ✓ when every descendant task is achieved,
 * otherwise the cursor's status if cursor falls under this subtree, else `·`.
 */

const GLYPHS = {
  achieved: '✓',
  pursuing: '▶',
  'review-pending': '🔵',
  blocked: '⛔',
  pending: '·',
};

function deepTaskCounts(node) {
  let total = 0;
  let done = 0;
  function walk(n) {
    if (n.type === 'task') {
      total += 1;
      if (n.status === 'achieved') done += 1;
    }
    for (const c of n.children) walk(c);
  }
  walk(node);
  return { total, done };
}

function nodeGlyph(node, cursorId) {
  if (node.type === 'task') return GLYPHS[node.status] ?? '?';
  const { total, done } = deepTaskCounts(node);
  if (total > 0 && done === total) return GLYPHS.achieved;
  // Derive from cursor descent.
  let cursorInside = false;
  function descent(n) {
    if (n.id === cursorId) { cursorInside = true; return; }
    for (const c of n.children) descent(c);
  }
  descent(node);
  if (cursorInside) return GLYPHS.pursuing;
  return GLYPHS.pending;
}

function renderTitle(node, cursorId) {
  const isCursor = node.id === cursorId;
  return `${node.id} ${nodeGlyph(node, cursorId)} ${node.title}${isCursor ? '  ← CURSOR' : ''}`;
}

/**
 * renderTree(tree, cursorId) → string
 */
export function renderTree(tree, cursorId) {
  const lines = [];
  lines.push(renderTitle(tree.root, cursorId));
  walkChildren(tree.root, cursorId, '', lines);
  return lines.join('\n');
}

function walkChildren(parent, cursorId, prefix, lines) {
  const children = parent.children ?? [];
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    const isLast = i === children.length - 1;
    const connector = isLast ? '└─' : '├─';
    lines.push(`${prefix}${connector} ${renderTitle(child, cursorId)}`);
    if (child.children && child.children.length > 0) {
      const nextPrefix = prefix + (isLast ? '   ' : '│  ');
      walkChildren(child, cursorId, nextPrefix, lines);
    }
  }
}
