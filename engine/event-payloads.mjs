/**
 * Per-event-kind payload schemas. ADR-0001 §Event taxonomy.
 *
 * Each event carries a header (id, ts, seq, goal_id, schema_version, kind,
 * turn_id) plus a kind-specific payload. This file is the authoritative
 * source for what shape every payload has.
 *
 * Adding a new event kind:
 *   1. Add the kind to EVENT_KIND_VALUES below.
 *   2. Add a payload schema export below.
 *   3. Add a branch in engine/reducer.mjs.
 *   4. Update docs/architecture/adr/0001-event-log-source-of-truth.md taxonomy.
 *   5. Bump that event's schema_version to 1 on first land.
 *
 * Renaming or changing a payload field for an existing kind requires a
 * per-event schema_version bump + a per-kind migration in the reducer.
 * Never silently change a kind's shape — events.jsonl is append-only and
 * older entries must continue to parse.
 */

import { z } from 'zod';

// The 15 canonical event kinds per ADR-0001 §Event taxonomy. Order matches
// the ADR's table for readability.
export const EVENT_KIND_VALUES = /** @type {const} */ ([
  'goal-created',
  'plan-approved',
  'started',
  'iteration-began',
  'evidence-added',
  'task-status-asserted',
  'cursor-advanced',
  'review-requested',
  'audit-verdict-received',
  'node-blocked',
  'lifecycle-changed',
  'budget-tally',
  'budget-exhausted',
  'manual-approve-applied',
  'cleared',
]);

export const EventKindSchema = z.enum(EVENT_KIND_VALUES);

// Shared payload primitives ------------------------------------------------

const TripleBudgetPayloadSchema = z.object({
  iterations: z.object({ used: z.number().int().nonnegative(), max: z.number().int().nonnegative() }),
  tokens: z.object({ used: z.number().int().nonnegative(), max: z.number().int().nonnegative() }),
  wallclock: z.object({
    started_at: z.string().datetime(),
    max_seconds: z.number().int().nonnegative(),
  }),
});

// Per-kind payload schemas -------------------------------------------------

export const GoalCreatedPayload = z.object({
  goal_id: z.string().min(1),
  mission: z.string().min(1),
  tree_skeleton: z.unknown(), // The full tree at creation. Not deep-validated here; saveTree does that.
  created_at: z.string().datetime(),
});

export const PlanApprovedPayload = z.object({
  approved_at: z.string().datetime(),
  validator_warnings: z.array(z.string()).optional(),
});

export const StartedPayload = z.object({
  session_id: z.string().min(1),
  budget: TripleBudgetPayloadSchema,
  started_at: z.string().datetime(),
  cursor: z.string().min(1),
});

export const IterationBeganPayload = z.object({
  iteration: z.number().int().nonnegative(),
  cursor: z.string().min(1),
});

export const EvidenceAddedPayload = z.object({
  cursor: z.string().min(1),
  criterion_index: z.number().int().nonnegative().nullable(),
  file: z.string().nullable().optional(),
  line: z.number().int().nullable().optional(),
  command: z.string().nullable().optional(),
  exit_code: z.number().int().nullable().optional(),
  note: z.string(),
});

export const TaskStatusAssertedPayload = z.object({
  cursor: z.string().min(1),
  value: z.enum(['pursuing', 'achieved', 'blocked']),
  blocker_reason: z.string().nullable().optional(),
});

export const CursorAdvancedPayload = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  reason: z.enum(['achieved', 'review-go', 'manual-approve']),
});

export const ReviewRequestedPayload = z.object({
  cursor: z.string().min(1),
  agents: z.array(z.string().min(1)),
});

export const AuditVerdictReceivedPayload = z.object({
  cursor: z.string().min(1),
  agent: z.string().min(1),
  status: z.enum(['GO', 'NOGO', 'REVISE']),
  text: z.string(),
  rejected: z.boolean().optional(),
  reason: z.string().optional(),
});

export const NodeBlockedPayload = z.object({
  cursor: z.string().min(1),
  reason: z.string(),
  review_attempts: z.number().int().nonnegative(),
});

export const LifecycleChangedPayload = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  reason: z.string().nullable().optional(),
});

export const BudgetTallyPayload = z.object({
  iterations: z.object({ used: z.number().int().nonnegative(), max: z.number().int().nonnegative() }),
  tokens: z.object({ used: z.number().int().nonnegative(), max: z.number().int().nonnegative() }),
  wallclock: z.object({
    elapsed_seconds: z.number().int().nonnegative(),
    max_seconds: z.number().int().nonnegative(),
  }),
});

export const BudgetExhaustedPayload = z.object({
  which: z.enum(['iterations', 'tokens', 'wallclock']),
  used: z.number().int().nonnegative(),
  max: z.number().int().nonnegative(),
});

export const ManualApproveAppliedPayload = z.object({
  cursor: z.string().min(1),
  reason: z.string(),
  user: z.string().optional(),
});

export const ClearedPayload = z.object({
  archived_to: z.string().nullable().optional(),
});

// Dispatch map: kind → payload schema. Used by the event-log reader to
// validate payloads after parsing the header.
export const PAYLOAD_SCHEMAS = /** @type {const} */ ({
  'goal-created': GoalCreatedPayload,
  'plan-approved': PlanApprovedPayload,
  'started': StartedPayload,
  'iteration-began': IterationBeganPayload,
  'evidence-added': EvidenceAddedPayload,
  'task-status-asserted': TaskStatusAssertedPayload,
  'cursor-advanced': CursorAdvancedPayload,
  'review-requested': ReviewRequestedPayload,
  'audit-verdict-received': AuditVerdictReceivedPayload,
  'node-blocked': NodeBlockedPayload,
  'lifecycle-changed': LifecycleChangedPayload,
  'budget-tally': BudgetTallyPayload,
  'budget-exhausted': BudgetExhaustedPayload,
  'manual-approve-applied': ManualApproveAppliedPayload,
  'cleared': ClearedPayload,
});

/**
 * Validate an event's payload against its kind's schema. Returns the typed
 * payload on success; throws zod error on failure.
 */
export function validatePayload(kind, payload) {
  const schema = PAYLOAD_SCHEMAS[kind];
  if (!schema) {
    throw new Error(`No payload schema registered for event kind: ${kind}`);
  }
  return schema.parse(payload);
}
