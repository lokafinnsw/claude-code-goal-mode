import { findNodeById } from './traversal.mjs';

// Returns a new tree (deep-cloned) with mutations applied, new state, and history entries.
export function applyMutations(treeIn, stateIn, tags, ts) {
  const tree = structuredClone(treeIn);
  const state = structuredClone(stateIn);
  const history = [];

  const cursorNode = findNodeById(tree, state.cursor);
  if (!cursorNode) {
    return { tree, state, history };
  }

  for (const tag of tags) {
    if (tag.kind === 'evidence') {
      cursorNode.evidence.push({
        ts,
        iteration: state.budget.iterations.used,
        criterion_index: tag.criterion,
        file: tag.file,
        line: tag.line,
        commit: null,
        command: tag.command,
        exit_code: tag.exit_code,
        note: tag.note,
      });
      history.push({
        ts,
        iteration: state.budget.iterations.used,
        event: 'evidence-added',
        node_id: cursorNode.id,
        payload: { criterion: tag.criterion, file: tag.file, command: tag.command },
      });
    }
  }

  return { tree, state, history };
}
