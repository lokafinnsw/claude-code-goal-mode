import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import { statePath, treePath, activeDir } from './paths.mjs';

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
  schema_version: z.literal(1),
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
  schema_version: z.literal(1),
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

function readWithBackup(target, parser) {
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
  return readWithBackup(statePath(projectRoot), GoalStateSchema);
}

export function saveState(projectRoot, state) {
  GoalStateSchema.parse(state);
  fs.mkdirSync(activeDir(projectRoot), { recursive: true });
  atomicWrite(statePath(projectRoot), JSON.stringify(state, null, 2));
}

export function loadTree(projectRoot) {
  return readWithBackup(treePath(projectRoot), GoalTreeSchema);
}

export function saveTree(projectRoot, tree) {
  GoalTreeSchema.parse(tree);
  fs.mkdirSync(activeDir(projectRoot), { recursive: true });
  atomicWrite(treePath(projectRoot), JSON.stringify(tree, null, 2));
}
