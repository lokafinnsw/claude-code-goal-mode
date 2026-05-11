/**
 * Pure reducer: events → {state, tree}.
 *
 * Per ADR-0001 §Reducer invariants:
 *   1. Pure function — no I/O, no Date.now(), no Math.random(). Timestamps
 *      come from event.ts fields.
 *   2. Single source — no caller mutates derived state outside this module.
 *   3. Replay-safe — same input events → same output state, byte-equal.
 *   4. Schema-versioned — dispatches on (kind, schema_version) per event.
 *
 * The reducer is the canonical implementation of "what the engine does with
 * an event log". v2.0.0-rc1 uses it in dual-write mode (events.jsonl is
 * appended alongside JSON state); v2.0.0-rc2 switches reads to flow through
 * here; v2.0.0 GA removes the legacy JSON write path.
 *
 * Inputs:
 *   - initialTree: the plan-as-written (every task pending, no evidence).
 *     Typically the `tree_skeleton` payload from the `goal-created` event,
 *     OR loaded from a snapshot when replaying from non-genesis.
 *   - events: array of EventLogEntry, sorted by seq ascending.
 *   - initialState (optional): when replaying from a snapshot, the cached
 *     state at the snapshot's seq. When omitted, defaults are derived.
 *
 * Output:
 *   { state, tree, applied, skipped }
 *     state: GoalState shape (matches engine/state.mjs zod schema)
 *     tree: GoalTree shape
 *     applied: count of events that produced a state mutation
 *     skipped: count of events that were no-ops (informational kinds, etc.)
 */

import { findNodeById, nextPendingTaskAfter } from './traversal.mjs';

const DEFAULT_LIFECYCLE = 'pursuing';

export function reduce(initialTree, events, initialState = null) {
  const tree = structuredClone(initialTree);
  const state = initialState
    ? structuredClone(initialState)
    : freshState(tree);

  let applied = 0;
  let skipped = 0;
  for (const e of events) {
    if (applyEvent(tree, state, e)) applied += 1;
    else skipped += 1;
  }
  return { state, tree, applied, skipped };
}

function freshState(tree) {
  const firstTask = nextPendingTaskAfter(tree, '_genesis_');
  return {
    schema_version: tree.schema_version ?? 2,
    goal_id: tree.goal_id,
    lifecycle: DEFAULT_LIFECYCLE,
    cursor: firstTask?.id ?? tree.root?.id ?? '',
    budget: {
      iterations: { used: 0, max: 0 },
      tokens: { used: 0, max: 0 },
      wallclock: { started_at: tree.created_at ?? '1970-01-01T00:00:00.000Z', max_seconds: 0 },
    },
    session_id: 'replay-derived',
    started_at: tree.approved_at ?? tree.created_at,
    paused_at: null,
    ended_at: null,
    ended_reason: null,
    history: [],
  };
}

function applyEvent(tree, state, event) {
  switch (event.kind) {
    case 'goal-created':
      return applyGoalCreated(tree, state, event);
    case 'plan-approved':
      return applyPlanApproved(tree, state, event);
    case 'started':
      return applyStarted(tree, state, event);
    case 'iteration-began':
      return applyIterationBegan(tree, state, event);
    case 'evidence-added':
      return applyEvidenceAdded(tree, state, event);
    case 'task-status-asserted':
      return applyTaskStatusAsserted(tree, state, event);
    case 'cursor-advanced':
      return applyCursorAdvanced(tree, state, event);
    case 'review-requested':
      return applyReviewRequested(tree, state, event);
    case 'audit-verdict-received':
      return applyAuditVerdictReceived(tree, state, event);
    case 'node-blocked':
      return applyNodeBlocked(tree, state, event);
    case 'lifecycle-changed':
      return applyLifecycleChanged(tree, state, event);
    case 'budget-tally':
      return applyBudgetTally(tree, state, event);
    case 'budget-exhausted':
      return applyBudgetExhausted(tree, state, event);
    case 'manual-approve-applied':
      return applyManualApproveApplied(tree, state, event);
    case 'cleared':
      return applyCleared(tree, state, event);
    default:
      return false; // unknown kinds are no-ops (forward-compat)
  }
}

// Per-kind branches ───────────────────────────────────────────────────────

function applyGoalCreated(tree, state, event) {
  // The initial goal-created event carries the full tree skeleton. When
  // replaying from genesis, this seeds the tree. When replaying from a
  // snapshot, we ignore it (snapshot already has the latest tree).
  const p = event.payload;
  if (p?.tree_skeleton) {
    Object.assign(tree, structuredClone(p.tree_skeleton));
  }
  if (p?.goal_id) state.goal_id = p.goal_id;
  if (p?.mission) tree.mission = p.mission;
  if (p?.created_at) {
    tree.created_at = p.created_at;
    state.started_at = p.created_at;
  }
  state.lifecycle = 'draft';
  state.history.push({
    ts: event.ts, iteration: 0, event: 'plan-created',
    node_id: null, payload: { goal_id: p?.goal_id },
  });
  return true;
}

function applyPlanApproved(tree, state, event) {
  const p = event.payload;
  if (p?.approved_at) tree.approved_at = p.approved_at;
  state.lifecycle = 'approved';
  state.history.push({
    ts: event.ts, iteration: 0, event: 'plan-approved',
    node_id: null, payload: { warnings: p?.validator_warnings ?? [] },
  });
  return true;
}

function applyStarted(tree, state, event) {
  const p = event.payload;
  if (p?.session_id) state.session_id = p.session_id;
  if (p?.budget) state.budget = structuredClone(p.budget);
  if (p?.started_at) state.started_at = p.started_at;
  if (p?.cursor) state.cursor = p.cursor;
  state.lifecycle = 'pursuing';
  state.history.push({
    ts: event.ts, iteration: 0, event: 'started',
    node_id: p?.cursor ?? null, payload: {},
  });
  return true;
}

function applyIterationBegan(tree, state, event) {
  const p = event.payload;
  if (typeof p?.iteration === 'number') {
    state.budget.iterations.used = Math.max(state.budget.iterations.used, p.iteration);
  }
  if (p?.cursor) state.cursor = p.cursor;
  return true;
}

function applyEvidenceAdded(tree, state, event) {
  const p = event.payload;
  if (!p?.cursor) return false;
  const node = findNodeById(tree, p.cursor);
  if (!node) return false;
  node.evidence.push({
    ts: event.ts,
    iteration: state.budget.iterations.used,
    criterion_index: p.criterion_index ?? null,
    file: p.file ?? null,
    line: p.line ?? null,
    commit: null,
    command: p.command ?? null,
    exit_code: p.exit_code ?? null,
    note: p.note ?? '',
  });
  state.history.push({
    ts: event.ts, iteration: state.budget.iterations.used,
    event: 'evidence-added', node_id: p.cursor,
    payload: { criterion: p.criterion_index, file: p.file, command: p.command },
  });
  return true;
}

function applyTaskStatusAsserted(tree, state, event) {
  const p = event.payload;
  if (!p?.cursor) return false;
  const node = findNodeById(tree, p.cursor);
  if (!node) return false;
  node.status = p.value;
  if (p.value === 'blocked' && p.blocker_reason) {
    node.blocker_reason = p.blocker_reason;
  }
  return true;
}

function applyCursorAdvanced(tree, state, event) {
  const p = event.payload;
  if (!p?.from || !p?.to) return false;
  const fromNode = findNodeById(tree, p.from);
  if (fromNode) fromNode.status = 'achieved';
  state.cursor = p.to;
  state.history.push({
    ts: event.ts, iteration: state.budget.iterations.used,
    event: 'cursor-advanced', node_id: p.from,
    payload: { from: p.from, to: p.to, reason: p.reason },
  });
  return true;
}

function applyReviewRequested(tree, state, event) {
  const p = event.payload;
  if (!p?.cursor) return false;
  const node = findNodeById(tree, p.cursor);
  if (!node) return false;
  node.status = 'review-pending';
  state.history.push({
    ts: event.ts, iteration: state.budget.iterations.used,
    event: 'review-requested', node_id: p.cursor,
    payload: { agents: p.agents ?? [] },
  });
  return true;
}

function applyAuditVerdictReceived(tree, state, event) {
  const p = event.payload;
  if (!p?.cursor) return false;
  state.history.push({
    ts: event.ts, iteration: state.budget.iterations.used,
    event: 'review-verdict', node_id: p.cursor,
    payload: {
      agent: p.agent, status: p.status, text: p.text,
      rejected: p.rejected ?? false, reason: p.reason,
    },
  });
  // The reducer doesn't decide GO/NOGO advancement here — that's a
  // higher-level orchestration concern. The emitter (stop-hook) emits
  // a subsequent `cursor-advanced` when allGo, or `node-blocked` when NOGO.
  return true;
}

function applyNodeBlocked(tree, state, event) {
  const p = event.payload;
  if (!p?.cursor) return false;
  const node = findNodeById(tree, p.cursor);
  if (!node) return false;
  node.status = 'blocked';
  node.blocker_reason = p.reason ?? null;
  node.review_attempts = Math.max(node.review_attempts ?? 0, p.review_attempts ?? 1);
  state.history.push({
    ts: event.ts, iteration: state.budget.iterations.used,
    event: 'node-blocked', node_id: p.cursor,
    payload: { reason: p.reason },
  });
  return true;
}

function applyLifecycleChanged(tree, state, event) {
  const p = event.payload;
  if (!p?.to) return false;
  state.lifecycle = p.to;
  if (['achieved', 'unmet', 'budget-limited'].includes(p.to)) {
    state.ended_at = event.ts;
    state.ended_reason = p.reason ?? null;
  }
  if (p.to === 'paused') state.paused_at = event.ts;
  if (p.to === 'pursuing' && p.from === 'paused') state.paused_at = null;
  state.history.push({
    ts: event.ts, iteration: state.budget.iterations.used,
    event: lifecycleHistoryEvent(p.to), node_id: null,
    payload: { reason: p.reason },
  });
  return true;
}

function lifecycleHistoryEvent(to) {
  switch (to) {
    case 'paused': return 'paused';
    case 'pursuing': return 'resumed';
    case 'achieved': return 'achieved';
    case 'unmet': return 'unmet';
    case 'budget-limited': return 'budget-exhausted';
    default: return 'started';
  }
}

function applyBudgetTally(tree, state, event) {
  const p = event.payload;
  if (typeof p?.iterations?.used === 'number') {
    state.budget.iterations.used = p.iterations.used;
  }
  if (typeof p?.iterations?.max === 'number' && p.iterations.max > 0) {
    state.budget.iterations.max = p.iterations.max;
  }
  if (typeof p?.tokens?.used === 'number') {
    state.budget.tokens.used = p.tokens.used;
  }
  if (typeof p?.tokens?.max === 'number' && p.tokens.max > 0) {
    state.budget.tokens.max = p.tokens.max;
  }
  return true;
}

function applyBudgetExhausted(tree, state, event) {
  const p = event.payload;
  state.lifecycle = 'budget-limited';
  state.ended_at = event.ts;
  state.ended_reason = `${p?.which ?? 'unknown'} budget exhausted`;
  state.history.push({
    ts: event.ts, iteration: state.budget.iterations.used,
    event: 'budget-exhausted', node_id: null,
    payload: { kind: p?.which, used: p?.used, max: p?.max },
  });
  return true;
}

function applyManualApproveApplied(tree, state, event) {
  const p = event.payload;
  if (!p?.cursor) return false;
  const node = findNodeById(tree, p.cursor);
  if (!node) return false;
  node.status = 'achieved';
  const next = nextPendingTaskAfter(tree, p.cursor);
  if (next) state.cursor = next.id;
  state.history.push({
    ts: event.ts, iteration: state.budget.iterations.used,
    event: 'cursor-advanced', node_id: p.cursor,
    payload: { from: p.cursor, reason: 'manual-approve', user: p.user },
  });
  return true;
}

function applyCleared(tree, state, event) {
  const p = event.payload;
  state.lifecycle = 'unmet';
  state.ended_at = event.ts;
  state.ended_reason = `goal cleared${p?.archived_to ? ` (archived to ${p.archived_to})` : ''}`;
  state.history.push({
    ts: event.ts, iteration: state.budget.iterations.used,
    event: 'cleared', node_id: null,
    payload: { archived_to: p?.archived_to },
  });
  return true;
}
