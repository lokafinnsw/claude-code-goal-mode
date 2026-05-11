/**
 * Replay engine — reconstruct {state, tree} from an event log.
 *
 * Pure function: same input events → same output, no I/O, no time, no random.
 * Used by:
 *   - Crash recovery in loadState (when state.json is missing/corrupt)
 *   - Doctor command (to show "events newer than snapshot" warning)
 *   - Forensic replay / debugging (engine/replay-cli.mjs in future)
 *
 * The replay model is deliberately small: only events that mutate
 * `state.cursor`, `state.lifecycle`, `state.history`, `tree.evidence[]`,
 * `tree.<node>.status`, or `tree.<node>.review_attempts` change derived
 * state. Budget ticks and informational entries do not affect the snapshot.
 *
 * v1.2.0 ships replay as a fallback path; the primary write path remains
 * the dual-writer in stop-hook (state.json + events.jsonl). When state.json
 * is missing or zod-rejected, loadState calls replayEvents on the initial
 * tree + readEvents() output to reconstruct.
 */

import { findNodeById, nextPendingTaskAfter } from './traversal.mjs';

/**
 * replayEvents(initialTree, events, initialState?)
 *
 * Walks events in order, applying state-mutating events to a derived
 * { state, tree } snapshot. The initialTree is the "plan as written" (every
 * task pending, no evidence). initialState provides budget caps and
 * lifecycle/cursor starting points — when omitted, defaults are derived
 * from the tree (lifecycle=pursuing, cursor=first-task, zero budget usage).
 *
 * Returns { state, tree, applied } where applied is the number of events
 * that produced a mutation (excludes informational/no-op events).
 */
export function replayEvents(initialTree, events, initialState = null) {
  const tree = structuredClone(initialTree);
  const firstTask = nextPendingTaskAfter(tree, '_synthetic_before_anything');
  const state = initialState
    ? structuredClone(initialState)
    : {
        schema_version: tree.schema_version ?? 2,
        goal_id: tree.goal_id,
        lifecycle: 'pursuing',
        cursor: firstTask?.id ?? tree.root.id,
        budget: {
          iterations: { used: 0, max: 0 },
          tokens: { used: 0, max: 0 },
          wallclock: { started_at: new Date().toISOString(), max_seconds: 0 },
        },
        session_id: 'replay-derived',
        started_at: tree.approved_at ?? tree.created_at,
        paused_at: null,
        ended_at: null,
        ended_reason: null,
        history: [],
      };

  let applied = 0;
  for (const e of events) {
    if (applyOneEvent(tree, state, e)) applied += 1;
  }
  return { state, tree, applied };
}

function applyOneEvent(tree, state, event) {
  switch (event.kind) {
    case 'goal-started': {
      // Seed full initial state from the start-goal event. Replay produces
      // a state.json equivalent to what saveState wrote at /goal-start time.
      if (event.payload.goal_id) state.goal_id = event.payload.goal_id;
      if (event.payload.session_id) state.session_id = event.payload.session_id;
      if (event.payload.cursor) state.cursor = event.payload.cursor;
      if (event.payload.started_at) state.started_at = event.payload.started_at;
      if (event.payload.budget) state.budget = structuredClone(event.payload.budget);
      state.lifecycle = 'pursuing';
      return true;
    }
    case 'budget-tick': {
      // Replay reconstructs counters monotonically — each tick reports the
      // CUMULATIVE used count at that moment.
      if (typeof event.payload.iterations_used === 'number') {
        state.budget.iterations.used = event.payload.iterations_used;
      }
      if (typeof event.payload.tokens_used === 'number') {
        state.budget.tokens.used = event.payload.tokens_used;
      }
      if (event.payload.session_id) state.session_id = event.payload.session_id;
      return true;
    }
    case 'evidence-recorded': {
      const nodeId = event.payload?.node_id;
      if (!nodeId) return false;
      const node = findNodeById(tree, nodeId);
      if (!node) return false;
      node.evidence.push({
        ts: event.ts,
        iteration: event.iteration,
        criterion_index: event.payload.criterion ?? null,
        file: event.payload.file ?? null,
        line: null,
        commit: null,
        command: event.payload.command ?? null,
        exit_code: null,
        note: event.payload.note ?? '',
      });
      return true;
    }
    case 'cursor-advanced': {
      const nodeId = event.payload?.node_id;
      if (!nodeId) return false;
      const node = findNodeById(tree, nodeId);
      if (node) {
        node.status = 'achieved';
      }
      const next = nextPendingTaskAfter(tree, nodeId);
      state.cursor = next ? next.id : nodeId;
      state.history.push({
        ts: event.ts,
        iteration: event.iteration,
        event: 'cursor-advanced',
        node_id: nodeId,
        payload: event.payload,
      });
      return true;
    }
    case 'blocker-set': {
      const nodeId = event.payload?.node_id;
      if (!nodeId) return false;
      const node = findNodeById(tree, nodeId);
      if (!node) return false;
      node.status = 'blocked';
      node.blocker_reason = event.payload.reason ?? null;
      node.review_attempts = (node.review_attempts ?? 0) + 1;
      return true;
    }
    case 'review-requested': {
      const nodeId = event.payload?.node_id;
      const node = findNodeById(tree, nodeId);
      if (node) node.status = 'review-pending';
      return true;
    }
    case 'review-verdict-accepted':
    case 'review-verdict-rejected':
      // Verdict events alone don't directly mutate cursor — they're paired
      // with subsequent cursor-advanced events when allGo. The verdict
      // record is preserved as a history entry for audit purposes.
      state.history.push({
        ts: event.ts,
        iteration: event.iteration,
        event: 'review-verdict',
        node_id: event.payload?.node_id ?? null,
        payload: event.payload,
      });
      return true;
    case 'lifecycle-changed': {
      const to = event.payload?.to;
      if (typeof to === 'string') {
        state.lifecycle = to;
        if (to === 'achieved' || to === 'unmet') {
          state.ended_at = event.ts;
        }
      }
      return true;
    }
    case 'session-rebound': {
      const newId = event.payload?.new_session_id;
      if (newId) state.session_id = newId;
      return true;
    }
    case 'budget-tick':
      // Replay doesn't reconstruct budget counters from events — those are
      // live values from the primary write path. Treated as informational.
      return false;
    default:
      return false;
  }
}
