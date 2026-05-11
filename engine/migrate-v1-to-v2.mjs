/**
 * v1.x → v2.0 migration: synthesise events.jsonl from existing
 * state.json + tree.json + state.history.
 *
 * Per ADR-0001 §Migration Phase C:
 *   - Existing-goal upgrade reads old `active/{tree,state}.json` and emits
 *     a believable initial event sequence (goal-created, plan-approved,
 *     started, then synthetic catch-up events derived from state.history
 *     entries).
 *   - Migration is **idempotent** — running twice produces the same event
 *     sequence (the second run detects events.jsonl already populated and
 *     skips).
 *
 * Output:
 *   - events.jsonl populated with N synthesized events at seq=0..N-1
 *   - snapshots/snap-<N-1>.json — final snapshot captures current state+tree
 *     so reader-switch (rc2) doesn't re-replay from genesis on first load
 *   - state.json.pre-v2-migration-<ts> + tree.json.pre-v2-migration-<ts>
 *     preserved backups (never auto-deleted — preserves forensics for any
 *     downstream issue post-migration)
 *
 * Returns:
 *   { migrated: true | false, eventCount, skipped?: string }
 *
 * On error: throws. Callers handle (typically: log + exit non-zero from CLI).
 *
 * History-event → v2-event mapping table (mirrors stop-hook.mjs::historyToEventPartial):
 *
 *   | history.event       | v2.kind                  | notes |
 *   |---------------------|--------------------------|-------|
 *   | plan-created        | goal-created             | always emitted as event 0 |
 *   | plan-approved       | plan-approved            | event 1 if tree.approved_at |
 *   | started             | started                  | event 2 if state.started_at |
 *   | cursor-advanced     | cursor-advanced          | preserve from/to/reason |
 *   | evidence-added      | evidence-added           | preserve cursor + criterion |
 *   | review-requested    | review-requested         | preserve agents |
 *   | review-verdict      | audit-verdict-received   | rejected flag in payload |
 *   | node-blocked        | node-blocked             | preserve reason + attempts |
 *   | paused, resumed     | lifecycle-changed        | derive from/to |
 *   | achieved, unmet     | lifecycle-changed        | terminal transitions |
 *   | budget-warning      | (skipped — informational) | |
 *   | budget-exhausted    | budget-exhausted         | preserve which/used/max |
 *   | cleared             | cleared                  | preserve archived_to |
 *   | session-rebound     | (skipped — engine-internal, no v2 kind) | |
 *   | evidence-required   | (skipped — informational) | |
 */

import fs from 'node:fs';
import path from 'node:path';
import { ulid } from 'ulid';
import { activeDir, statePath, treePath } from './paths.mjs';
import { eventsPath, countEvents, CURRENT_EVENT_SCHEMA_VERSION, EventLogEntrySchema } from './event-log.mjs';
import { validatePayload } from './event-payloads.mjs';
import { writeSnapshot } from './snapshots.mjs';
import { loadState, loadTree } from './state.mjs';

export class MigrationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MigrationError';
  }
}

export function migrateV1ToV2(projectRoot, opts = {}) {
  // Idempotency check: if events.jsonl already has any v2-shape entries,
  // assume migration was done. Re-running would only duplicate.
  if (countEvents(projectRoot) > 0 && !opts.force) {
    return { migrated: false, eventCount: 0, skipped: 'events.jsonl already populated; pass { force: true } to override' };
  }

  const tree = loadTree(projectRoot);
  const state = loadState(projectRoot);

  if (!tree && !state) {
    return { migrated: false, eventCount: 0, skipped: 'no active goal (no tree.json or state.json)' };
  }
  if (!tree) {
    throw new MigrationError('migrate-v1-to-v2: state.json present but tree.json missing; cannot synthesize goal-created event without the tree skeleton');
  }

  const goalId = tree.goal_id;
  const events = [];
  let seq = 0;
  const emit = (kind, payload, ts) => {
    const event = {
      id: ulid(),
      ts: ts ?? new Date().toISOString(),
      seq: seq++,
      goal_id: goalId,
      schema_version: CURRENT_EVENT_SCHEMA_VERSION,
      kind,
      turn_id: null,
      payload: validatePayload(kind, payload),
    };
    EventLogEntrySchema.parse(event);
    events.push(event);
  };

  // 1. goal-created. Carries the v1 tree skeleton — but we reset per-node
  //    state (evidence/status/blocker_reason/review_attempts) because the
  //    history-replay events below will reconstruct them. This avoids
  //    double-application of state that's both in the snapshot AND in
  //    history events.
  const skeleton = scrubTreeToSkeleton(tree);
  emit('goal-created', {
    goal_id: goalId,
    mission: tree.mission ?? 'migrated from v1',
    tree_skeleton: skeleton,
    created_at: tree.created_at ?? new Date().toISOString(),
  }, tree.created_at);

  // 2. plan-approved.
  if (tree.approved_at) {
    emit('plan-approved', { approved_at: tree.approved_at }, tree.approved_at);
  }

  // 3. started.
  if (state?.started_at) {
    emit('started', {
      session_id: state.session_id,
      budget: state.budget,
      started_at: state.started_at,
      cursor: state.cursor,
    }, state.started_at);
  }

  // 4. Replay state.history → v2 events (skip the ones we already emitted).
  for (const h of state?.history ?? []) {
    if (h.event === 'plan-created') continue;
    if (h.event === 'plan-approved') continue;
    if (h.event === 'started') continue;
    if (h.event === 'session-rebound') continue;
    if (h.event === 'budget-warning') continue;

    const partial = mapHistoryEntryToV2(h, goalId);
    if (!partial) continue;
    emit(partial.kind, partial.payload, h.ts);
  }

  // Atomic-ish write: serialize, then single appendFileSync to a fresh file.
  // Use a temp + rename for atomicity.
  fs.mkdirSync(activeDir(projectRoot), { recursive: true });
  const fp = eventsPath(projectRoot);
  const tmpFp = fp + '.migration-tmp';
  const body = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
  fs.writeFileSync(tmpFp, body);
  fs.renameSync(tmpFp, fp);

  // Final snapshot: capture the current state+tree so reader-switch (rc2)
  // doesn't replay from genesis on first load. Snapshot at last-emitted seq.
  if (state && events.length > 0) {
    writeSnapshot(projectRoot, events[events.length - 1].seq, state, tree);
  }

  // Preserve originals as backups (never auto-deleted).
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  for (const target of [statePath(projectRoot), treePath(projectRoot)]) {
    if (fs.existsSync(target)) {
      try { fs.copyFileSync(target, `${target}.pre-v2-migration-${ts}`); } catch (_) {}
    }
  }

  return { migrated: true, eventCount: events.length };
}

/**
 * Strip per-node mutation state from the tree so the goal-created event
 * carries only the plan skeleton. evidence/status/blocker_reason/
 * review_attempts will be reconstructed by replay of subsequent events.
 */
function scrubTreeToSkeleton(tree) {
  const cloned = structuredClone(tree);
  scrub(cloned.root);
  return cloned;
}

function scrub(node) {
  node.status = 'pending';
  node.evidence = [];
  node.blocker_reason = null;
  node.review_attempts = 0;
  node.notes = [];
  for (const c of node.children ?? []) scrub(c);
}

function mapHistoryEntryToV2(h, goalId) {
  if (h.event === 'evidence-added') {
    return {
      kind: 'evidence-added',
      payload: {
        cursor: h.node_id ?? h.payload?.cursor ?? 'unknown',
        criterion_index: h.payload?.criterion_index ?? h.payload?.criterion ?? null,
        file: h.payload?.file ?? null,
        command: h.payload?.command ?? null,
        note: h.payload?.note ?? 'migrated from v1 history',
      },
    };
  }
  if (h.event === 'cursor-advanced') {
    return {
      kind: 'cursor-advanced',
      payload: {
        from: h.payload?.from ?? h.node_id ?? 'unknown',
        to: h.payload?.to ?? h.node_id ?? 'unknown',
        reason: h.payload?.reason === 'review-go' ? 'review-go'
              : h.payload?.from === 'manual-approve' ? 'manual-approve'
              : 'achieved',
      },
    };
  }
  if (h.event === 'review-requested') {
    return {
      kind: 'review-requested',
      payload: { cursor: h.node_id ?? 'unknown', agents: h.payload?.agents ?? [] },
    };
  }
  if (h.event === 'review-verdict') {
    return {
      kind: 'audit-verdict-received',
      payload: {
        cursor: h.node_id ?? 'unknown',
        agent: h.payload?.agent ?? 'unknown',
        status: ['GO', 'NOGO', 'REVISE'].includes(h.payload?.status) ? h.payload.status : 'NOGO',
        text: h.payload?.text ?? '',
        rejected: h.payload?.rejected ?? false,
        reason: h.payload?.reason,
      },
    };
  }
  if (h.event === 'node-blocked') {
    return {
      kind: 'node-blocked',
      payload: {
        cursor: h.node_id ?? 'unknown',
        reason: h.payload?.reason ?? 'no reason recorded',
        review_attempts: h.payload?.review_attempts ?? 1,
      },
    };
  }
  if (h.event === 'paused') {
    return {
      kind: 'lifecycle-changed',
      payload: { from: 'pursuing', to: 'paused', reason: h.payload?.reason ?? null },
    };
  }
  if (h.event === 'resumed') {
    return {
      kind: 'lifecycle-changed',
      payload: { from: 'paused', to: 'pursuing', reason: h.payload?.reason ?? null },
    };
  }
  if (h.event === 'achieved') {
    return {
      kind: 'lifecycle-changed',
      payload: { from: 'pursuing', to: 'achieved', reason: h.payload?.reason ?? 'all tasks achieved' },
    };
  }
  if (h.event === 'unmet') {
    return {
      kind: 'lifecycle-changed',
      payload: { from: 'pursuing', to: 'unmet', reason: h.payload?.reason ?? 'manually abandoned' },
    };
  }
  if (h.event === 'budget-exhausted') {
    return {
      kind: 'budget-exhausted',
      payload: {
        which: h.payload?.kind ?? h.payload?.which ?? 'iterations',
        used: h.payload?.used ?? 0,
        max: h.payload?.max ?? 0,
      },
    };
  }
  if (h.event === 'cleared') {
    return {
      kind: 'cleared',
      payload: { archived_to: h.payload?.archived_to ?? null },
    };
  }
  return null;
}

// CLI entry — `node engine/migrate-v1-to-v2.mjs [--force] [--cwd <path>]`
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const cwdIdx = args.indexOf('--cwd');
  const cwd = cwdIdx >= 0 ? args[cwdIdx + 1] : process.cwd();
  try {
    const result = migrateV1ToV2(cwd, { force });
    if (result.migrated) {
      process.stdout.write(`✓ Migrated v1 → v2: ${result.eventCount} events synthesized.\n`);
      process.exit(0);
    } else {
      process.stdout.write(`· No migration needed: ${result.skipped}\n`);
      process.exit(0);
    }
  } catch (err) {
    process.stderr.write(`✗ Migration failed: ${err.message}\n`);
    process.exit(1);
  }
}
