import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import { statePath, treePath, activeDir } from './paths.mjs';
import { CURRENT_SCHEMA_VERSION, runMigrations } from './migrations.mjs';
// Static imports to support sync event-sourced reads (rc2 reader-switch).
// These modules don't import back from state.mjs, so no circular dependency.
import { findLatestSnapshot } from './snapshots.mjs';
import { readEvents } from './event-log.mjs';
import { reduce } from './reducer.mjs';
import { withLockSync } from './lock.mjs';

export const NodeStatusSchema = z.enum([
  'pending',
  'pursuing',
  'review-pending',
  'achieved',
  'blocked',
  'skipped',
]);

export const NodeTypeSchema = z.enum(['sprint', 'epic', 'task']);

export const EvidenceSchema = z.object({
  ts: z.string().datetime(),
  iteration: z.number().int().nonnegative(),
  criterion_index: z.number().int().nonnegative().nullable(),
  file: z.string().nullable(),
  line: z.number().int().nullable(),
  commit: z.string().nullable(),
  command: z.string().nullable(),
  exit_code: z.number().int().nullable(),
  note: z.string(),
});

const baseNode = z.object({
  id: z.string().min(1),
  type: NodeTypeSchema,
  title: z.string().min(1),
  goal: z.string().min(1),
  acceptance_criteria: z.array(z.string().min(1)),
  review: z.array(z.string().min(1)),
  validate: z.string().nullable(),
  work_front: z.string().nullable(),
  status: NodeStatusSchema,
  evidence: z.array(EvidenceSchema),
  blocker_reason: z.string().nullable(),
  review_attempts: z.number().int().nonnegative(),
  notes: z.array(z.string()),
});

// GoalNodeObjectSchema: extensible ZodObject (safe for .extend())
// Children reference GoalNodeSchema (the refined version) so the refine
// fires recursively on every node in the tree, not just the root.
export const GoalNodeObjectSchema = baseNode.extend({
  children: z.lazy(() => z.array(GoalNodeSchema)),
});

// GoalNodeSchema: refined wrapper — validates task nodes have ≥1 criterion.
// Use GoalNodeObjectSchema if you need to .extend() further.
export const GoalNodeSchema = GoalNodeObjectSchema.refine(
  node => node.type !== 'task' || node.acceptance_criteria.length >= 1,
  { message: 'task node must have at least one acceptance_criteria' }
);

export const GoalTreeSchema = z.object({
  schema_version: z.literal(2),
  goal_id: z.string().min(1),
  mission: z.string().min(1),
  created_at: z.string().datetime(),
  approved_at: z.string().datetime().nullable(),
  root: GoalNodeSchema,
});

export const LifecycleSchema = z.enum([
  'draft',
  'approved',
  'pursuing',
  'paused',
  'achieved',
  'unmet',
  'budget-limited',
]);

// History event tag. v2.0.3 (bug I2 fix) liberalized this from a strict zod
// enum to a non-empty string so that adding a new event kind in
// apply-mutations.mjs doesn't immediately break `saveState` (which calls
// GoalStateSchema.parse). The semantic enum is still maintained here
// (KNOWN_HISTORY_EVENTS) for documentation and forensic-tool consumption;
// callers that want the strict check can validate against it explicitly.
// Real per-event-kind validation lives in event-payloads.mjs (the event-log
// canonical path) — state.history is a v1 cache, intentionally open-schema.
export const KNOWN_HISTORY_EVENTS = Object.freeze([
  'plan-created',
  'plan-approved',
  'started',
  'paused',
  'resumed',
  'cursor-advanced',
  'node-blocked',
  'review-requested',
  'review-verdict',
  'evidence-added',
  'budget-warning',
  'budget-exhausted',
  'achieved',
  'unmet',
  'cleared',
  'session-rebound',
]);

export const HistoryEventSchema = z.string().min(1);

export const HistoryEntrySchema = z.object({
  ts: z.string().datetime(),
  iteration: z.number().int().nonnegative(),
  event: HistoryEventSchema,
  node_id: z.string().nullable(),
  payload: z.record(z.string(), z.unknown()),
});

export const TripleBudgetSchema = z.object({
  iterations: z.object({
    used: z.number().int().nonnegative(),
    max: z.number().int().nonnegative(),
  }),
  tokens: z.object({
    used: z.number().int().nonnegative(),
    max: z.number().int().nonnegative(),
  }),
  wallclock: z.object({
    started_at: z.string().datetime(),
    max_seconds: z.number().int().nonnegative(),
  }),
});

export const GoalStateSchema = z.object({
  schema_version: z.literal(2),
  goal_id: z.string().min(1),
  lifecycle: LifecycleSchema,
  cursor: z.string().min(1),
  budget: TripleBudgetSchema,
  session_id: z.string().min(1),
  started_at: z.string().datetime().nullable(),
  paused_at: z.string().datetime().nullable(),
  ended_at: z.string().datetime().nullable(),
  ended_reason: z.string().nullable(),
  history: z.array(HistoryEntrySchema),
});

function atomicWrite(target, content) {
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = target + '.tmp';
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, target);
}

function readWithBackup(target, parser, kind /* 'state' | 'tree' */) {
  let raw;
  try {
    raw = fs.readFileSync(target, 'utf8');
  } catch (err) {
    // ENOENT = file missing (normal, no goal active). Other errors (EACCES, EPERM, EISDIR):
    // no backup to make since we couldn't read; just signal "no usable state".
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    // Auto-migrate before zod validation. If the on-disk schema_version is
    // lower than CURRENT_SCHEMA_VERSION, runMigrations lifts it forward and
    // we preserve the original raw JSON as a .pre-migration-v<old>-<ts> backup
    // before atomic-writing the migrated form. This means future loads short-
    // circuit (schema_version already current) and forensic recovery is
    // possible if a migration ever turns out to be wrong.
    const fromVersion = parsed?.schema_version;
    if (typeof fromVersion === 'number' && fromVersion < CURRENT_SCHEMA_VERSION) {
      const isState = kind === 'state';
      const isTree = kind === 'tree';
      const result = runMigrations(
        isState ? parsed : null,
        isTree ? parsed : null,
        fromVersion,
        CURRENT_SCHEMA_VERSION,
      );
      if (result.error) {
        throw new Error(`auto-migration v${fromVersion}→v${CURRENT_SCHEMA_VERSION} failed: ${result.error}`);
      }
      const migrated = isState ? result.state : result.tree;
      if (migrated && result.applied.length > 0) {
        // Preserve original.
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const backupPath = `${target}.pre-migration-v${fromVersion}-${ts}`;
        try { fs.copyFileSync(target, backupPath); } catch (_) {}
        // Retention: keep last PRE_MIGRATION_KEEP backups for this target,
        // delete older. Without this, every load of a v1 state creates a
        // new backup file forever.
        try {
          const PRE_MIGRATION_KEEP = 3;
          const dir = path.dirname(target);
          const base = path.basename(target);
          const prefix = `${base}.pre-migration-v`;
          const existing = fs.readdirSync(dir)
            .filter((f) => f.startsWith(prefix))
            .map((f) => ({ f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
            .sort((a, b) => b.mtime - a.mtime);
          for (const e of existing.slice(PRE_MIGRATION_KEEP)) {
            try { fs.unlinkSync(path.join(dir, e.f)); } catch (_) {}
          }
        } catch (_) {}
        // Atomic-write the migrated form.
        atomicWrite(target, JSON.stringify(migrated, null, 2));
      }
      return parser.parse(migrated);
    }
    return parser.parse(parsed);
  } catch (err) {
    // Read succeeded but data is corrupt or schema-invalid: preserve as
    // .broken-<ts>-<seq>. The sequence suffix prevents collisions when
    // multiple corrupt loads happen within the same millisecond (tight
    // crash-loops) — without it copyFileSync silently overwrites and we
    // lose forensic data.
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    let seq = 0;
    let dst;
    do {
      dst = `${target}.broken-${ts}-${seq++}`;
    } while (fs.existsSync(dst));
    try { fs.copyFileSync(target, dst); } catch (_) {}
    return null;
  }
}

/**
 * Load state from the JSON cache (legacy path).
 *
 * Phase 8 GA decision: `loadState` continues to read state.json directly.
 * The event log is canonical for **recovery** (`loadStateFromEvents`) and
 * **forensics**, but the JSON cache stays primary for normal reads. Full
 * reader-switch (loadState routing through events) is deferred to v2.1.0
 * where apply-mutations is also refactored to be event-driven (avoids the
 * dual-write doubling problem where saveState bakes a mutation into the
 * cache AND stop-hook emits an event that the reducer would re-apply).
 *
 * The `cache-freshness` doctor check enforces that the JSON cache agrees
 * with the event log — drift surfaces as a `fail` status.
 *
 * `{ legacyJson: true }` is accepted for explicit "I want the JSON cache,
 * not any future cutover" callers; currently a no-op but reserved for
 * v2.1.0 cutover.
 */
export function loadState(projectRoot, opts = {}) {
  // `opts` reserved for v2.1.0 reader-switch; currently legacy JSON read.
  void opts;
  return readWithBackup(statePath(projectRoot), GoalStateSchema, 'state');
}

/**
 * Snapshot-aware load (ADR-0001 Phase 7 reader-switch).
 *
 * Algorithm:
 *   1. Find latest snapshot under .claude/goals/active/snapshots/.
 *   2. Read events with seq > snapshot.seq (tail).
 *   3. Reduce tail against snapshot.tree + snapshot.state.
 *
 * Returns null when neither snapshot nor events.jsonl exists. Otherwise
 * returns `{state, tree}` reconstructed from the event log.
 *
 * Synchronous (rc2 — was async in alpha2 via dynamic imports; now static).
 *
 * v2.0.3 (bug C5 fix): cache write-back was REMOVED. The pre-v2.0.3 code
 * unconditionally wrote the replayed state+tree back to state.json /
 * tree.json on every loadStateFromEvents call, WITHOUT holding the
 * ADR-0002 lock. That raced against any concurrent Stop-hook write,
 * occasionally producing a half-state where state.json was the new value
 * but tree.json was still the previous (or vice versa) — atomic rename is
 * atomic per file, not across the pair.
 *
 * Cache write-back is a v2.1.0 Phase 8 concern (the full reader-switch
 * cutover), at which point apply-mutations.mjs becomes event-driven and
 * the cache becomes a derived projection updated only via the reducer.
 * Until then, `loadState`/`loadTree` remain the cache-of-record (written
 * by saveState/saveTree under the per-goal lock) and this function is
 * read-only — useful for forensic replay and doctor's cache-freshness
 * check.
 *
 * The legacy `opts.writeCache` parameter is accepted but ignored, so any
 * v2.0.x test or external caller that passed `{ writeCache: false }` still
 * works (the value is now always false in practice).
 */
export function loadStateFromEvents(projectRoot, opts = {}) {
  // writeCache option is intentionally ignored as of v2.0.3 (bug C5 fix).
  // Read-only by construction.
  // eslint-disable-next-line no-unused-vars
  const { writeCache: _writeCache, ...readOpts } = opts;
  const latest = findLatestSnapshot(projectRoot);
  const allEvents = readEvents(projectRoot, readOpts);
  let result;
  if (!latest) {
    if (allEvents.length === 0) return null;
    // CRITICAL: use legacyJson:true to bypass the loadTree → loadStateFromEvents
    // cutover. Otherwise infinite recursion when events exist + no snapshot:
    // loadStateFromEvents → loadTree → loadStateFromEvents → ...
    const seedTree = loadTree(projectRoot, { legacyJson: true });
    // Seed reducer's initialState with the JSON cache so non-`started`/`goal-created`
    // event sequences preserve the existing cursor/session_id/lifecycle. Tests
    // that save state then run stop-hook (which emits only budget-tally events,
    // not a full `started` event) rely on this — without it, the replayed state
    // resets to freshState defaults (cursor=first-pending, session_id='replay-derived').
    const seedState = loadState(projectRoot, { legacyJson: true });
    if (seedTree) {
      result = reduce(seedTree, allEvents, seedState);
    } else {
      const goalCreated = allEvents.find((e) => e.kind === 'goal-created');
      if (!goalCreated?.payload?.tree_skeleton) return null;
      result = reduce(goalCreated.payload.tree_skeleton, allEvents, seedState);
    }
  } else {
    const tail = allEvents.filter((e) => e.seq > latest.seq);
    result = reduce(latest.snapshot.tree, tail, latest.snapshot.state);
  }
  return result;
}

/**
 * Explicit crash-cache recovery: replay events into state+tree, take the
 * ADR-0002 lock, and rewrite the JSON cache. Use this when state.json
 * and/or tree.json went missing or corrupt and you want the cache restored
 * from the event-log canonical truth.
 *
 * v2.0.3 (bug C5 fix): pre-v2.0.3, `loadStateFromEvents` did this rewrite
 * unconditionally on every read, WITHOUT the lock. That raced against any
 * concurrent Stop-hook write and could leave state.json and tree.json
 * out of sync with each other. The explicit recovery function moved that
 * dangerous unconditional write to an opt-in API that takes the lock.
 *
 * Returns the recovered `{state, tree}` or null when events.jsonl is also
 * empty/absent. Throws if the lock cannot be acquired within the default
 * timeout (caller can catch and retry).
 *
 * SYNCHRONOUS lock variant (withLockSync) — recovery is rare and short.
 */
export function recoverCacheFromEvents(projectRoot) {
  return withLockSync(activeDir(projectRoot), 'recover-cache-from-events', {}, () => {
    const result = loadStateFromEvents(projectRoot);
    if (!result) return null;
    fs.mkdirSync(activeDir(projectRoot), { recursive: true });
    const stateValidated = autoMigrateInput(result.state, 'state');
    GoalStateSchema.parse(stateValidated);
    atomicWrite(statePath(projectRoot), JSON.stringify(stateValidated, null, 2));
    const treeValidated = autoMigrateInput(result.tree, 'tree');
    GoalTreeSchema.parse(treeValidated);
    atomicWrite(treePath(projectRoot), JSON.stringify(treeValidated, null, 2));
    return { state: stateValidated, tree: treeValidated };
  });
}

/**
 * Async crash-recovery loader. Same semantics as loadState but with proper
 * ESM dynamic import so the event-log fallback actually works. Callers
 * (Stop hook, SessionStart hook) can await this when they care about
 * recovery; synchronous callers (validate-plan, doctor checks) keep using
 * loadState() which returns null on missing state.
 */
export async function loadStateWithRecovery(projectRoot) {
  const direct = readWithBackup(statePath(projectRoot), GoalStateSchema, 'state');
  if (direct) return direct;
  const tree = readWithBackup(treePath(projectRoot), GoalTreeSchema, 'tree');
  if (!tree) return null;
  try {
    const { readEvents } = await import('./event-log.mjs');
    const { replayEvents } = await import('./state-from-events.mjs');
    const events = readEvents(projectRoot);
    if (events.length === 0) return null;
    const { state } = replayEvents(tree, events);
    // Persist the recovered state so subsequent loadState calls short-circuit.
    saveState(projectRoot, state);
    process.stderr.write(
      `[goal-mode] state.json was missing/corrupt; recovered from ${events.length} events.jsonl entries\n`,
    );
    return state;
  } catch (err) {
    process.stderr.write(`[goal-mode] crash recovery failed: ${err.message}\n`);
    return null;
  }
}

export function saveState(projectRoot, state) {
  // Tolerate stale schema_version on input by auto-migrating before validation.
  // This means callers (tests, CLI commands, ad-hoc node scripts) don't need
  // to know the current schema version — they just pass any state object the
  // engine has ever produced. saveState lifts it forward and persists v_current.
  const upgraded = autoMigrateInput(state, 'state');
  // History rotation: when the live state.history exceeds STATE_HISTORY_LIMIT
  // entries, move the oldest half to .claude/goals/archive/history-<ts>.jsonl
  // so the live state.json stays bounded. Archive is append-only JSONL.
  const HISTORY_LIMIT = 200;
  const HISTORY_KEEP = 100;
  if (Array.isArray(upgraded.history) && upgraded.history.length > HISTORY_LIMIT) {
    const cut = upgraded.history.length - HISTORY_KEEP;
    const archived = upgraded.history.slice(0, cut);
    const archiveRoot = path.join(projectRoot, '.claude', 'goals', 'archive');
    fs.mkdirSync(archiveRoot, { recursive: true });
    // Bug I3 fix: ms-precision ts alone can collide if two rotations land in
    // the same millisecond (test bursts, fast successive Stop-hook fires).
    // Append a seq suffix that increments until a free filename is found.
    // Use appendFileSync (not writeFileSync) so any collision that still
    // slips through writes-appends rather than overwriting.
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    let seq = 0;
    let archivePath;
    do {
      archivePath = path.join(archiveRoot, `history-${ts}-${String(seq).padStart(3, '0')}.jsonl`);
      seq += 1;
    } while (fs.existsSync(archivePath) && seq < 1000);
    fs.appendFileSync(archivePath, archived.map((e) => JSON.stringify(e)).join('\n') + '\n');
    upgraded.history = upgraded.history.slice(cut);
  }
  GoalStateSchema.parse(upgraded);
  fs.mkdirSync(activeDir(projectRoot), { recursive: true });
  atomicWrite(statePath(projectRoot), JSON.stringify(upgraded, null, 2));
}

/**
 * Load tree from the JSON cache. Same Phase 8 GA decision as `loadState`:
 * cache remains primary; event-sourced reads are explicitly opt-in via
 * `loadStateFromEvents`.
 */
export function loadTree(projectRoot, opts = {}) {
  void opts;
  return readWithBackup(treePath(projectRoot), GoalTreeSchema, 'tree');
}

export function saveTree(projectRoot, tree) {
  const upgraded = autoMigrateInput(tree, 'tree');
  GoalTreeSchema.parse(upgraded);
  fs.mkdirSync(activeDir(projectRoot), { recursive: true });
  atomicWrite(treePath(projectRoot), JSON.stringify(upgraded, null, 2));
}

/**
 * Auto-migrate input to CURRENT_SCHEMA_VERSION before save validation.
 * Pure function; does not mutate input. Returns input unchanged if already
 * at current version. Throws on migration error so save fails loud.
 */
function autoMigrateInput(input, kind /* 'state' | 'tree' */) {
  const fromVersion = input?.schema_version;
  if (typeof fromVersion !== 'number' || fromVersion === CURRENT_SCHEMA_VERSION) {
    return input;
  }
  if (fromVersion > CURRENT_SCHEMA_VERSION) {
    throw new Error(
      `cannot save: input schema_version=${fromVersion} is higher than engine CURRENT_SCHEMA_VERSION=${CURRENT_SCHEMA_VERSION}`,
    );
  }
  const result = runMigrations(
    kind === 'state' ? input : null,
    kind === 'tree' ? input : null,
    fromVersion,
    CURRENT_SCHEMA_VERSION,
  );
  if (result.error) {
    throw new Error(`save auto-migration v${fromVersion}→v${CURRENT_SCHEMA_VERSION} failed: ${result.error}`);
  }
  return kind === 'state' ? result.state : result.tree;
}
