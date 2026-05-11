# Acceptance gates — when each ADR ships

Explicit, testable ship criteria per ADR. The release is held until every
listed gate is PASS. Skipped gates are explicit `BLOCKED: <reason>`, never
silent.

## ADR-0001 — Event log as source of truth (v2.0.0)

### Gate G1.1 — Property-based reducer determinism
- **Spec:** generate 1000 random valid event sequences (each 50–500 events
  long, drawn from the 15-kind taxonomy with valid per-kind payloads).
  Replay each sequence twice; assert byte-equal `{state, tree}` outputs.
- **Pass:** 1000/1000 pairs equal, zero exceptions.
- **Tool:** `fast-check` for property generation, structuredClone + JSON
  serialize for equality.

### Gate G1.2 — v1→v2 migration preserves state byte-equivalent
- **Spec:** for every `.tree.json` + `.state.json` in `docs/EXAMPLES/`, run
  `engine/migrate-v1-to-v2.mjs` to synthesize events.jsonl; then run reducer
  to reproduce `{state, tree}`. Compare to original v1 source.
- **Pass:** for every example, `state.cursor` matches, `state.lifecycle`
  matches, every `tree.<node>.status` matches, every `tree.<node>.evidence`
  matches (deep-equal). Informational drift (e.g., `state.history` digest
  formatting) acceptable; flag as known diffs in `docs/v2-migration-diffs.md`.
- **Tool:** vitest snapshot comparison, structuredClone deep-equal.

### Gate G1.3 — Cold replay performance
- **Spec:** generate a synthetic 10,000-event log; measure replay time
  from `events.jsonl` to derived `{state, tree}` on cold cache (no
  snapshot).
- **Pass:** p50 < 500ms, p99 < 2000ms on M1 / 8GB hardware tier.
- **Tool:** vitest benchmark suite.

### Gate G1.4 — Warm replay performance
- **Spec:** same 10,000-event log, but load with snapshot at event 9000;
  measure tail replay (events 9001–10000).
- **Pass:** p50 < 50ms, p99 < 200ms.

### Gate G1.5 — Crash injection recovery
- **Spec:** spawn subprocess that emits 100 events, kill -9 after event 75
  during in-progress write. Parent reloads state, asserts replayable.
- **Pass:** replay produces state consistent with events 1–75 (partial-line
  detection on event 76 is OK).
- **Repeat:** 100 random crash points; 100/100 successful recoveries.

### Gate G1.6 — Reducer pure-function check
- **Spec:** lint rule + grep gate in CI that asserts no `Date.now()`,
  `Math.random()`, `process.env`, `fs.*`, or other side effects in
  `engine/reducer.mjs` body.
- **Pass:** CI green.

### Gate G1.7 — Self-meta-test
- **Spec:** the goal-mode self-improvement goal in
  `.claude/goals/active/` of this repo migrates and continues operating.
- **Pass:** `/goal-doctor` shows ok for every check after migration.

---

## ADR-0002 — Concurrent session locking (v1.3.0) — SHIPPED

### Gate G2.1 — Lock primitive correctness ✅
- **Spec:** unit tests for acquire/release/stale-detection/PID-liveness.
- **Status:** PASS — `tests/lock.test.mjs` 25/25.

### Gate G2.2 — Multi-process contention ✅
- **Spec:** spawn 2–3 concurrent acquirers; assert serialization (no
  overlapping hold intervals).
- **Status:** PASS — `tests/lock-contention.test.mjs` 3/3 (incl.
  SIGKILL recovery).

### Gate G2.3 — Wired into all 7 write sites + Stop hook ✅
- **Spec:** every write-intent function acquires; read-only paths do not.
- **Status:** PASS — manual verification + 705/706 full-suite pass.

### Gate G2.4 — Stop-hook contention behaviour
- **Spec:** when lock is held by CLI script, Stop hook returns
  `{exit:0, stdout:null, error:<lock-timeout-msg>}` after 5s wait. User
  sees stderr diagnostic, no continuation prompt this turn.
- **Status:** Code path implemented. Test not yet written. **BLOCKED:
  expand `tests/lock-contention.test.mjs` to include Stop-hook scenario.**

### Gate G2.5 — Live Mancelot dogfood (1 week)
- **Spec:** v1.3.0 deployed to Mancelot; user runs a parallel CLI command
  during a Stop hook fire; observes serialization behaviour.
- **Status:** **BLOCKED:** awaiting deployment.

---

## ADR-0003 — Multi-goal namespace (v2.1.0)

### Gate G3.1 — Per-goal directory layout
- **Spec:** every example v1 plan migrates from `active/` to
  `<goal-id>/` via `engine/migrate-v1-to-v2-layout.mjs`. Files preserved.
- **Pass:** for every example, post-migration `<goal-id>/events.jsonl` +
  `derived/state.json` + `derived/tree.json` are loadable.

### Gate G3.2 — Active pointer atomicity
- **Spec:** spawn N processes calling `setActiveGoalId(root, ...)`
  simultaneously with distinct goal_ids. Final `.active` content equals
  one of the N values (not garbage, no partial write).
- **Pass:** 100 iterations of 3-way race, zero corruption.

### Gate G3.3 — Cross-goal isolation
- **Spec:** acquire lock on goal A; assert lock acquire on goal B succeeds
  immediately (per-goal locks are independent).
- **Pass:** 100ms lock-on-B with goal-A lock held.

### Gate G3.4 — `/goal-list` / `/goal-switch` / `/goal-fork` behaviour
- **Spec:** end-to-end test against a fresh project: plan A, plan B,
  list (both shown), switch to A, fork A as C, switch to C, delete B.
  Final state has goals A + C, B archived.
- **Pass:** test passes.

---

## ADR-0004 — Plan-as-code TypeScript DSL (v2.2.0)

### Gate G4.1 — DSL → JSON round-trip equivalence
- **Spec:** 5 reference plans authored in `plan.ts` produce identical
  events as equivalent hand-authored `tree.json` plans (via
  `goalToResolved` + reducer to {state, tree}).
- **Pass:** byte-equal except for `created_at` timestamps.

### Gate G4.2 — Compile-time errors caught
- **Spec:** test fixtures with deliberately broken plans:
  - missing acceptance criteria
  - duplicate task IDs
  - unknown reviewer subagent_type
- **Pass:** TypeScript compiler errors at expected lines.

### Gate G4.3 — npm publishing dry-run
- **Spec:** `npm publish --dry-run` for `@goal-mode/schema` and
  `@goal-mode/plan-dsl` packages.
- **Pass:** dry-run exits 0, package size < 100KB each.

### Gate G4.4 — Plan-replacement evidence preservation
- **Spec:** recompile a plan with:
  (a) task ID unchanged, criteria unchanged → existing evidence preserved
  (b) task ID renamed → evidence dropped for old ID, fresh node for new
  (c) same ID, criterion count changed → evidence dropped
- **Pass:** all three scenarios produce expected state via test fixtures.

### Gate G4.5 — Mancelot dogfood
- **Spec:** Mancelot MVP roadmap re-authored in plan.ts (or partial); diff
  against existing tree.json shows zero meaningful drift.
- **Pass:** drift confined to ID auto-generation conventions; documented
  in PR.

---

## Cross-cutting gates (every release)

### Gate GX.1 — Full test suite green
- **Spec:** `npx vitest run` PASS for every test file. Zero skipped tests
  that are admitted tech debt (skipped legacy-placeholder tests OK with
  comment explaining why).

### Gate GX.2 — install.sh end-to-end against tmp HOME
- **Spec:** existing `tests/v1.2.1-patches.test.mjs::#9` runs.
- **Pass:** PASS.

### Gate GX.3 — Doctor PASS against self-improvement goal
- **Spec:** `bash scripts/doctor.sh` against the goal-mode repo's own
  `.claude/goals/active/` returns exit 0 (or exit 1 only on expected
  budget-headroom warnings during long sessions).

### Gate GX.4 — CHANGELOG.md entry present
- **Spec:** every release commit includes a `## [X.Y.Z] — YYYY-MM-DD`
  section under "Released" matching the manifest version.

### Gate GX.5 — Rollback documented
- **Spec:** entry in `docs/architecture/versioning.md` "Rollback policy"
  table describing downgrade from this release to the prior.
