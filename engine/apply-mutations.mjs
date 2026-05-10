/**
 * Pure mutation engine for the goal-mode plan-tree.
 *
 * Function: applyMutations(treeIn, stateIn, tags, ts) → { tree, state, history }
 *
 * Inputs and outputs:
 *   - treeIn:  the current plan-tree object (zod GoalTreeSchema-shaped).
 *   - stateIn: the current run-state object (zod GoalStateSchema-shaped).
 *   - tags:    typed tag array as emitted by `parseTags()` from `parse-tags.mjs`.
 *   - ts:      ISO-8601 timestamp string used for new history entries.
 *   - returns: a NEW tree (deep-cloned via structuredClone), a NEW state (also
 *              deep-cloned, with `history` already extended), and the array of
 *              new history entries appended in this call. Original inputs are
 *              never mutated.
 *
 * Branch ordering and precedence (single linear pass through the tag stream):
 *   1. Evidence loop: every `evidence` tag pushes onto cursorNode.evidence and
 *      emits an `evidence-added` history entry.
 *   2. Task-status (single, first-wins via tags.find): handles 'achieved',
 *      'blocked', 'pursuing'. 'achieved' gates on allCriteriaCovered.
 *   3. Review-request: if cursorNode is still pursuing and criteria covered,
 *      transitions to review-pending.
 *   4. Audit-verdict batch: only consumed when status === 'review-pending'.
 *      Strict NOGO-wins: if any verdict is NOGO/REVISE, cursorNode returns to
 *      pursuing and review_attempts increments; on review_attempts >= 3 the
 *      node is auto-blocked. Otherwise, all-GO requires every required
 *      reviewer to have at least one verdict AND none of their verdicts to be
 *      non-GO; if so, the node achieves and the cursor advances.
 *   5. Terminal-achieved lifecycle: fires when the cursor's task is achieved
 *      and there is no pending successor (nextPendingTaskAfter === null).
 *      Note: cursor advancement (steps 2/4) advances the cursor to the
 *      successor; if no successor exists, cursor stays on the just-achieved
 *      node, which is exactly what makes this check fire.
 *   6. Terminal-unmet lifecycle: fires when the cursor's node is blocked AND
 *      its review_attempts has reached 3. Block-counter is incremented in two
 *      places: the audit-verdict NOGO branch and the task-status:blocked
 *      branch. Both feed the same counter so this check covers either path.
 *
 * Block-counter contract:
 *   cursorNode.review_attempts is incremented under exactly two conditions:
 *     - An audit-verdict batch contains at least one NOGO or REVISE.
 *     - A task-status tag with value 'blocked' is processed.
 *   Both increments are by 1 per applyMutations call (so 3 NOGOs in one batch
 *   bumps the counter by 1, not 3 — matching "3 consecutive iterations" not
 *   "3 individual NOGO verdicts").
 *
 * Coverage check (allCriteriaCovered):
 *   A criterion is considered covered when at least one evidence entry has a
 *   criterion_index in [0, acceptance_criteria.length). Out-of-range indices
 *   (negative, or >= length) are silently dropped from coverage but the
 *   evidence record itself is still pushed onto cursorNode.evidence (parsing
 *   succeeded; we just don't credit it). Empty acceptance_criteria []
 *   trivially evaluates to "all covered" — sprint/epic nodes with no criteria
 *   advance immediately on a 'task-status:achieved' tag.
 *
 * Cursor advancement note:
 *   cursorNode is captured at function entry via findNodeById(tree, state.cursor)
 *   and held by reference for the rest of the call. Once cursor advances to a
 *   successor (steps 2/4), evidence and other tags emitted later in the SAME
 *   tag stream still land on the original cursorNode. Parse-tags emits all
 *   evidence tags before any task-status tag in canonical agent output, so
 *   this ordering is the contract; agents emitting tags out-of-canonical-order
 *   need to be aware their late evidence lands on the closing-out task.
 *
 * History semantics:
 *   - history is built up locally during the call and appended to state.history
 *     at the end.
 *   - The function ALSO returns history as a separate field for callers that
 *     want the new entries without slicing state.history.
 *   - Both views are equivalent (state.history.slice(-history.length) ===
 *     history when the input state.history is preserved).
 *
 * Pure (modulo opts.auditsDir): no globals, no Math.random. Inputs are
 * deep-cloned via structuredClone; the original objects are never mutated.
 *
 * opts.auditsDir (optional, Phase 7):
 *   When provided, every audit-verdict tag in `tags` produces a JSON file
 *   under `opts.auditsDir` capturing { ts, node_id, kind:'audit-verdict',
 *   agent, status, text }. Files are written regardless of advance/no-
 *   advance outcome (i.e. NOGO verdicts persist alongside GOs). Filename
 *   shape: `<node-id>-<ts-with-colon-and-dot-replaced-by-dash>-<agent>.json`.
 *   Omitting opts.auditsDir preserves pre-Phase-7 pure behavior — no I/O
 *   anywhere.
 */
import fs from 'node:fs';
import path from 'node:path';
import { findNodeById, nextPendingTaskAfter } from './traversal.mjs';

// Defensive filename sanitization: agent and node_id ultimately come from
// user-edited tree.json. If they contain '/' or other path-illegal chars,
// fs.writeFileSync would either fail (ENOENT, missing parent dir) or write
// to an unintended subdirectory. Sanitization is filename-only — the JSON
// body keeps the original unsanitized values.
function safeFilenamePart(s) {
  // Allow [a-zA-Z0-9._-]; collapse runs of 2+ dots to '_' to prevent '..'
  // surviving sanitization (defense-in-depth against future code paths
  // that may use the sanitized string as a path COMPONENT — currently it
  // is always embedded in a larger token, so '..' has no exploit, but the
  // belt-and-braces guard costs nothing).
  return String(s).replace(/[^a-zA-Z0-9._-]/g, '_').replace(/\.{2,}/g, '_');
}

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
export function applyMutations(treeIn, stateIn, tags, ts, opts = {}) {
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
      cursorNode.review_attempts += 1;  // I2: same counter feeds I1's unmet check
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
    // Hoist mkdirSync out of the per-verdict loop: directory creation is
    // idempotent but unnecessary work to repeat for every verdict in a batch.
    if (opts.auditsDir) fs.mkdirSync(opts.auditsDir, { recursive: true });
    for (const v of verdicts) {
      history.push({
        ts, iteration: state.budget.iterations.used,
        event: 'review-verdict', node_id: cursorNode.id,
        payload: { agent: v.agent, status: v.status, text: v.text },
      });
      // Phase 7: persist verdict to disk when caller wires opts.auditsDir.
      // Written BEFORE the allGo/anyNo gate below so NOGO verdicts persist too.
      if (opts.auditsDir) {
        const fname = `${safeFilenamePart(cursorNode.id)}-${ts.replace(/[:.]/g, '-')}-${safeFilenamePart(v.agent)}.json`;
        const body = {
          ts,
          node_id: cursorNode.id,
          kind: 'audit-verdict',
          agent: v.agent,
          status: v.status,
          text: v.text,
        };
        fs.writeFileSync(path.join(opts.auditsDir, fname), JSON.stringify(body, null, 2));
      }
    }
    // Strict: any NOGO/REVISE blocks advancement, even mixed with GOs in the same batch.
    const anyNo = verdicts.some(v => v.status === 'NOGO' || v.status === 'REVISE');
    // allGo: every required reviewer has at least one verdict AND none of their verdicts are non-GO.
    const allGo = !anyNo && cursorNode.review.every(agent => {
      const fromAgent = verdicts.filter(v => v.agent === agent);
      return fromAgent.length > 0 && fromAgent.every(v => v.status === 'GO');
    });
    if (anyNo) {
      cursorNode.status = 'pursuing';
      cursorNode.review_attempts += 1;
      if (cursorNode.review_attempts >= 3) {
        cursorNode.status = 'blocked';
        cursorNode.blocker_reason = `3 consecutive review cycles ended in NOGO/REVISE`;
        history.push({ ts, iteration: state.budget.iterations.used, event: 'node-blocked', node_id: cursorNode.id, payload: { reason: cursorNode.blocker_reason } });
      }
    } else if (allGo) {
      cursorNode.status = 'achieved';
      history.push({ ts, iteration: state.budget.iterations.used, event: 'cursor-advanced', node_id: cursorNode.id, payload: { from: 'review-go' } });
      const nextTask = nextPendingTaskAfter(tree, cursorNode.id);
      state.cursor = nextTask ? nextTask.id : cursorNode.id;
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

  // Unmet: any node has accumulated 3 review_attempts AND is currently blocked.
  // review_attempts is the authoritative per-node block counter — incremented
  // in both the audit-verdict NOGO/REVISE branch and the task-status:blocked
  // branch (see I2 fix).
  if (state.lifecycle === 'pursuing') {
    const cur = findNodeById(tree, state.cursor);
    if (cur && cur.status === 'blocked' && cur.review_attempts >= 3) {
      state.lifecycle = 'unmet';
      state.ended_at = ts;
      state.ended_reason = '3 consecutive blocks on the same node';
      history.push({ ts, iteration: state.budget.iterations.used, event: 'unmet', node_id: cur.id, payload: {} });
    }
  }

  // Append accumulated history to state
  state.history.push(...history);

  return { tree, state, history };
}
