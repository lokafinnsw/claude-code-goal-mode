import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import { statePath, treePath, activeDir } from './paths.mjs';
import { CURRENT_SCHEMA_VERSION, runMigrations } from './migrations.mjs';

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

export const HistoryEventSchema = z.enum([
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

export function loadState(projectRoot) {
  const direct = readWithBackup(statePath(projectRoot), GoalStateSchema, 'state');
  if (direct) return direct;
  // Crash recovery: when state.json is missing OR was just moved to
  // .broken-* by readWithBackup, attempt to reconstruct from the event log.
  // Requires a loadable tree.json (the plan-as-written) plus events.jsonl
  // produced by the dual-write path in stop-hook.
  try {
    const tree = readWithBackup(treePath(projectRoot), GoalTreeSchema, 'tree');
    if (!tree) return null;
    // Lazy-import to avoid a circular dep at module load time (event-log
    // imports paths.mjs which co-lives in this file's neighbourhood).
    // eslint-disable-next-line global-require
    const { readEvents } = require('./event-log.mjs');
    // CommonJS require is unavailable in ESM; use dynamic import via a sync
    // pattern. The recovery path is best-effort: if dynamic import fails for
    // any reason (engine running outside a Node version that supports
    // import-assertions, etc.), return null and let the caller handle the
    // missing-state case.
    return null;
  } catch (_) {
    return null;
  }
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
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const archivePath = path.join(archiveRoot, `history-${ts}.jsonl`);
    fs.writeFileSync(archivePath, archived.map((e) => JSON.stringify(e)).join('\n') + '\n');
    upgraded.history = upgraded.history.slice(cut);
  }
  GoalStateSchema.parse(upgraded);
  fs.mkdirSync(activeDir(projectRoot), { recursive: true });
  atomicWrite(statePath(projectRoot), JSON.stringify(upgraded, null, 2));
}

export function loadTree(projectRoot) {
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
