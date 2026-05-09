export function walkLeafTasks(tree) {
  const out = [];
  function visit(node) {
    if (node.type === 'task') {
      out.push(node);
      return;
    }
    for (const child of node.children) visit(child);
  }
  visit(tree.root);
  return out;
}

export function findNodeById(tree, id) {
  function visit(node) {
    if (node.id === id) return node;
    for (const child of node.children) {
      const r = visit(child);
      if (r) return r;
    }
    return null;
  }
  return visit(tree.root);
}
