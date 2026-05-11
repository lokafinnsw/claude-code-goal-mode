/**
 * Migration v1 → v2.
 *
 * Background: v1.1.19 added the 'session-rebound' history event to support
 * /compact-aware auto-rebind, but kept GoalStateSchema schema_version at the
 * literal 1. The actual on-disk shape diverged from the literal; that mismatch
 * was the root cause of the "engine встал" bug observed during the mancelot
 * Sprint 0 work (zod throw on legitimate session-rebound entries from manual
 * jq patches under v1.1.18).
 *
 * v2 formalises what v1.1.19+ have been emitting:
 *   - state.history MAY contain entries with event === 'session-rebound'
 *   - schema_version is the literal 2 on every freshly-saved state and tree
 *
 * Structurally there are no other changes between v1 and v2. The migration
 * is a pure schema_version bump plus an optional notes entry recording the
 * upgrade for forensic/audit purposes.
 *
 * Pre-conditions: input is a parsed-but-unvalidated JSON object that conforms
 * to v1 shape (schema_version === 1).
 *
 * Post-conditions: output schema_version === 2; original object is NOT mutated
 * (we deep-clone via structured spreading so callers can keep the original
 * for .pre-migration backups without surprises).
 */

export const fromVersion = 1;
export const toVersion = 2;

export function migrateState(stateV1) {
  // Deep-clone-ish: shallow spread + spread the budget (which is the deepest
  // nested object that callers might mutate). history is an array of plain
  // objects — we keep references; immutability guarantee is "this fn does not
  // mutate input.history", which we satisfy by constructing a new array.
  return {
    ...stateV1,
    schema_version: 2,
    budget: {
      ...stateV1.budget,
      iterations: { ...stateV1.budget.iterations },
      tokens: { ...stateV1.budget.tokens },
      wallclock: { ...stateV1.budget.wallclock },
    },
    history: [...stateV1.history],
  };
}

export function migrateTree(treeV1) {
  // No structural tree changes from v1 to v2; only schema_version bumps.
  return {
    ...treeV1,
    schema_version: 2,
    root: cloneNode(treeV1.root),
  };
}

function cloneNode(node) {
  return {
    ...node,
    acceptance_criteria: [...node.acceptance_criteria],
    review: [...node.review],
    evidence: node.evidence.map((e) => ({ ...e })),
    notes: [...node.notes],
    children: node.children.map(cloneNode),
  };
}
