import { findNodeById, nextPendingTaskAfter } from './traversal.mjs';

function allCriteriaCovered(node) {
  const covered = new Set();
  for (const ev of node.evidence) {
    if (ev.criterion_index !== null && ev.criterion_index >= 0 && ev.criterion_index < node.acceptance_criteria.length) {
      covered.add(ev.criterion_index);
    }
  }
  return covered.size >= node.acceptance_criteria.length;
}

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

  const statusTag = tags.find(t => t.kind === 'task-status');
  if (statusTag) {
    if (statusTag.value === 'achieved') {
      if (allCriteriaCovered(cursorNode)) {
        // empty review[] → mark achieved + advance immediately
        if (cursorNode.review.length === 0) {
          cursorNode.status = 'achieved';
          history.push({ ts, iteration: state.budget.iterations.used, event: 'cursor-advanced', node_id: cursorNode.id, payload: { from: 'achieved' } });
          const nextTask = nextPendingTaskAfter(tree, cursorNode.id);
          state.cursor = nextTask ? nextTask.id : cursorNode.id;
        } else {
          cursorNode.status = 'review-pending';
          history.push({ ts, iteration: state.budget.iterations.used, event: 'review-requested', node_id: cursorNode.id, payload: { agents: cursorNode.review } });
        }
      } else {
        cursorNode.status = 'pursuing';
      }
    } else if (statusTag.value === 'blocked') {
      cursorNode.status = 'blocked';
      const blockerTag = tags.find(t => t.kind === 'blocker');
      if (blockerTag) cursorNode.blocker_reason = blockerTag.reason;
      history.push({ ts, iteration: state.budget.iterations.used, event: 'node-blocked', node_id: cursorNode.id, payload: { reason: cursorNode.blocker_reason } });
    } else if (statusTag.value === 'pursuing') {
      cursorNode.status = 'pursuing';
    }
  }

  return { tree, state, history };
}
