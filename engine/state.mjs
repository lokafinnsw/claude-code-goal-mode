import { z } from 'zod';

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
