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

  const reviewReq = tags.find(t => t.kind === 'review-request');
  if (reviewReq && cursorNode.status === 'pursuing' && allCriteriaCovered(cursorNode)) {
    cursorNode.status = 'review-pending';
    history.push({ ts, iteration: state.budget.iterations.used, event: 'review-requested', node_id: cursorNode.id, payload: { agents: reviewReq.agents } });
  }

  const verdicts = tags.filter(t => t.kind === 'audit-verdict');
  if (verdicts.length > 0 && cursorNode.status === 'review-pending') {
    for (const v of verdicts) {
      history.push({
        ts, iteration: state.budget.iterations.used,
        event: 'review-verdict', node_id: cursorNode.id,
        payload: { agent: v.agent, status: v.status, text: v.text },
      });
    }
    const allGo = cursorNode.review.every(agent => verdicts.find(v => v.agent === agent && v.status === 'GO'));
    const anyNo = verdicts.some(v => v.status === 'NOGO' || v.status === 'REVISE');
    if (allGo) {
      cursorNode.status = 'achieved';
      history.push({ ts, iteration: state.budget.iterations.used, event: 'cursor-advanced', node_id: cursorNode.id, payload: { from: 'review-go' } });
      const nextTask = nextPendingTaskAfter(tree, cursorNode.id);
      state.cursor = nextTask ? nextTask.id : cursorNode.id;
    } else if (anyNo) {
      cursorNode.status = 'pursuing';
      cursorNode.review_attempts += 1;
      if (cursorNode.review_attempts >= 3) {
        cursorNode.status = 'blocked';
        cursorNode.blocker_reason = `3 consecutive review cycles ended in NOGO/REVISE`;
        history.push({ ts, iteration: state.budget.iterations.used, event: 'node-blocked', node_id: cursorNode.id, payload: { reason: cursorNode.blocker_reason } });
      }
    }
  }

  // Achieved: cursor unchanged AND no next pending AND cursor task is achieved
  if (state.lifecycle === 'pursuing') {
    const cur = findNodeById(tree, state.cursor);
    if (cur && cur.status === 'achieved' && nextPendingTaskAfter(tree, cur.id) === null) {
      state.lifecycle = 'achieved';
      state.ended_at = ts;
      state.ended_reason = 'all tasks achieved';
      history.push({ ts, iteration: state.budget.iterations.used, event: 'achieved', node_id: null, payload: {} });
    }
  }

  // Unmet: 3 consecutive node-blocked events for the same node
  if (state.lifecycle === 'pursuing') {
    const blockedRun = [...state.history.slice(-2), ...history.filter(h => h.event === 'node-blocked')]
      .filter(h => h.event === 'node-blocked');
    if (blockedRun.length >= 3 && blockedRun.slice(-3).every(h => h.node_id === blockedRun[blockedRun.length - 1].node_id)) {
      state.lifecycle = 'unmet';
      state.ended_at = ts;
      state.ended_reason = '3 consecutive blocks on the same node';
      history.push({ ts, iteration: state.budget.iterations.used, event: 'unmet', node_id: blockedRun[blockedRun.length - 1].node_id, payload: {} });
    }
  }

  // Append accumulated history to state
  state.history.push(...history);

  return { tree, state, history };
}
