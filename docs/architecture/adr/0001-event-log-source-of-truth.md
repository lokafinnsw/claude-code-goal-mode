# ADR 0001 — Event log as source of truth

- **Status:** Proposed
- **Date:** 2026-05-10
- **Tags:** v2.0.0, refactor, breaking-change, state-management
- **Supersedes:** None
- **Refines:** ADR 0002 (locking; see below)
- **Original label:** D1 (v2 brainstorm 2026-05-10)

## Context

Today's v1.x state model lives in three loosely-coupled files inside `.claude/goals/active/`:

| File | Nature | Owner | Updated by |
|---|---|---|---|
| `tree.json` | Plan + accumulated mutations (status, evidence, review_attempts, blocker_reason) | engine | Stop-hook on every turn |
| `state.json` | Cursor, lifecycle, triple budget, history[] (summary entries) | engine | Stop-hook + every CLI script |
| `notes.md` | Append-only one-line iteration digest | engine | Stop-hook (and any process via `appendFileSync`) |
| `audits/<id>.json` | Per-verdict review record | engine | Stop-hook on audit-verdict tags |

Each Stop turn runs: `loadTree() + loadState()` → `parseTags(transcript)` → `applyMutations()` → `saveTree() + saveState()` → `appendFileSync(notesPath, digest)`. CLI scripts (`pause`, `resume`, `clear`, `abandon`, `approve`, `manual-approve`, `start`) each take their own load → mutate → save path against state.json (and sometimes tree.json).

This worked through Phase 10 and v1.1.x ship, but **three structural problems are now blocking further work**:

1. **No canonical sequence of truth.** Three files all hold derived state. The list of "what happened in what order" is encoded into `state.history[]` (summarized events), `tree.evidence[]` (criterion-level proof), `tree.notes[]` (ephemeral per-node text), `audits/` (verdict files), and `notes.md` (one-line digest) — fanned out across five surfaces with no single ordering. Audit / replay / forensic reconstruction requires reasoning over all five and reconciling timestamps.

2. **Concurrent-write races between Stop-hook and CLI scripts.** The Stop hook fires when Claude finishes a turn. A user can run `/goal-pause` from a parallel terminal at any moment, including mid-Stop-hook. The window between `loadState()` and `saveState()` in the Stop hook is the entire body of `applyMutations()` plus disk writes — easily 50–200ms. If `/goal-pause` writes to `state.json` in that window, one side's mutation is silently lost. ADR-0002 addresses the **locking** of writes; this ADR addresses making writes themselves **atomic and ordered** by design.

3. **Multi-goal namespace (ADR-0003 / D4) cannot ship cleanly on mutable JSON.** Once we have N goals living side by side, each one has its own state, but cross-goal queries ("which goal is most behind on budget?", "show me the last 20 events across all goals") require a unified event stream. Hand-merging N `state.history[]` arrays at read time is a hack; an event log per goal — or one shared log with goal_id discriminator — is the right shape.

A fourth, softer pressure: **everything we want to add downstream is easier on an event log**. Replay-on-failure for hardening tests, "what if this verdict had been NOGO" simulations for debugging, time-travel UI for `/goal-status`, remote-agent dispatch (background mode, Codex-SDK route), Plan-DSL (ADR-0004) compilation traces — all these are trivial over an append-only log and awkward over mutable JSON.

## Decision

We adopt **event-sourcing**. `events.jsonl` (append-only, one JSON event per line) becomes the **canonical source of truth**. Tree and state become **derived caches**, regenerable from the event sequence at any time. The plugin retains the same external API (commands, slash-command surface, prompt templates) — the change is internal.

### Event taxonomy

The engine defines a closed set of event kinds, each with a typed payload. Initial taxonomy (15 kinds, derived from current `applyMutations` + CLI scripts):

| Kind | Payload | Emitted by |
|---|---|---|
| `goal-created` | `{ goal_id, mission, tree_skeleton, created_at }` | `/goal-plan`, `/goal-plan-from-file` |
| `plan-approved` | `{ approved_at, validator_warnings? }` | `/goal-approve-plan` |
| `started` | `{ session_id, budget: TripleBudget, started_at, cursor }` | `/goal-start` |
| `iteration-began` | `{ iteration, cursor }` | Stop hook (first action of every turn) |
| `evidence-added` | `{ cursor, criterion_index, file?, line?, command?, exit_code?, note }` | Stop hook |
| `task-status-asserted` | `{ cursor, value: 'pursuing'\|'achieved'\|'blocked', blocker_reason? }` | Stop hook |
| `cursor-advanced` | `{ from, to, reason: 'achieved'\|'review-go'\|'manual-approve' }` | Stop hook + `/goal-approve` |
| `review-requested` | `{ cursor, agents }` | Stop hook |
| `audit-verdict-received` | `{ cursor, agent, status, text, rejected? }` | Stop hook |
| `node-blocked` | `{ cursor, reason, review_attempts }` | Stop hook |
| `lifecycle-changed` | `{ from, to, reason }` | Stop hook + `/goal-pause` + `/goal-resume` + `/goal-abandon` |
| `budget-tally` | `{ iterations: {used,max}, tokens: {used,max}, wallclock: {elapsed_seconds,max_seconds} }` | Stop hook (every turn) |
| `budget-exhausted` | `{ which: 'iterations'\|'tokens'\|'wallclock', used, max }` | Stop hook |
| `manual-approve-applied` | `{ cursor, reason, user }` | `/goal-approve` |
| `cleared` | `{ archived_to? }` | `/goal-clear` |

Each event has a header: `{ id: ULID, ts: ISO-8601, goal_id, schema_version }`. The body is the kind-specific payload. New event kinds are added by bumping schema_version on the new event only (events are versioned individually, not the file as a whole).

### Derived views

The engine exposes a pure **reducer**: `reduce(events: Event[]): { tree, state }`. Given the full event sequence, it produces the same `tree.json` + `state.json` shape v1.x ships. Reading goal status, rendering continuation prompts, validating plans — all hit the reducer, never read the raw events directly.

Two read modes:

- **Hot read** (every Stop hook, every `/goal-status`): replay since last snapshot, fold against snapshot's state. Snapshot every N events (default N=100) or every M minutes since last (default M=15min). Snapshot is a full materialized `{ tree, state }` blob stored as `snapshots/<event-id>.json`.
- **Cold read** (replay/audit/forensics): replay from event 0. Useful for `--from-scratch` diagnostics and for testing reducer correctness.

### File layout (v2.0.0)

```
.claude/goals/<goal-id>/                  ← per-goal namespace (ADR-0003)
├── events.jsonl                          ← APPEND-ONLY canonical source
├── snapshots/                            ← periodic full-state snapshots
│   ├── <event-id-1>.json                 ← state after event-id-1
│   └── <event-id-2>.json
├── derived/                              ← read-only cache (rebuildable any time)
│   ├── tree.json                         ← same shape as v1.x
│   └── state.json                        ← same shape as v1.x
├── plan.md                               ← unchanged (human-readable)
├── notes.md                              ← unchanged (append-only digest)
└── audits/                               ← unchanged (one file per verdict)
```

The `derived/` directory is **regenerable** — losing it doesn't lose any data. CI / hardening tests will include "delete derived/, rebuild, assert identical to pre-delete state" as a regression.

### Reducer invariants

1. **Pure function.** `reduce(events)` is deterministic, no I/O, no `Date.now()`. Timestamps come from event `ts` fields.
2. **Single source.** No code path mutates derived state without first appending an event. Static analysis (eslint rule + grep gate in CI) enforces.
3. **Replay-safe.** Replaying the full event log against a fresh state must produce the exact same `{ tree, state }` as the cached `derived/`. CI test asserts this on every PR.
4. **Schema-versioned.** Each event carries its own `schema_version`. The reducer dispatches on version per event, never globally. Backward compatibility is a per-event commitment.

## Consequences

### Positive

- **Race-free writes.** Append to JSONL is atomic on POSIX (single `write(2)` of ≤ PIPE_BUF bytes per line, which is 4096 on macOS/Linux). Multiple processes appending simultaneously interleave at line granularity but never corrupt a line.
- **Auditability.** Every state change is a labeled, timestamped record. `cat events.jsonl | jq 'select(.kind=="audit-verdict-received")'` reproduces the full review history.
- **Replay-driven testing.** Hardening test suite gets a new primitive: replay-from-zero, replay-skipping-N-events, replay-with-mutated-event — all become 5-line fixture builders.
- **Schema evolution.** Adding a field to `audit-verdict-received` payload requires only bumping that event's `schema_version` and teaching the reducer. No global migration.
- **D3 (multi-goal, ADR-0003) becomes trivial.** Each goal has its own `events.jsonl`. Cross-goal queries iterate over multiple files.
- **D4 (Plan-DSL, ADR-0004) integrates cleanly.** DSL compilation emits a `goal-created` event with the full tree skeleton; the same event flows through the same reducer regardless of whether the plan came from LLM or DSL.

### Negative

- **Reducer becomes the canonical place that knows all event semantics.** Today this logic is spread across `applyMutations.mjs`, eight `*-cli.mjs` scripts, and `stop-hook.mjs`. The reducer concentrates it. This is a coupling shift, not a creation of new complexity — but it changes the mental model.
- **Snapshot housekeeping.** When does a snapshot become stale? How many do we keep? Default: keep all snapshots within last 7 days OR last 100 events, whichever is more. Configurable, documented in `BUDGET.md`.
- **Performance cliff at cold read.** A goal with 10,000 events would take seconds to reduce from zero. Snapshot strategy prevents this from being user-visible — but the worst case is real. Mitigated by aggressive snapshot policy and by keeping reducer pure-functional (V8 optimizes it well).
- **Disk usage.** Events.jsonl grows monotonically. A typical 200-task goal at 10 events/iteration × 100 iterations = 2000 events × ~300 bytes/event = ~600KB per goal. Snapshots add ~50KB each × 20 retained = 1MB. Total per-goal cost ~1.6MB — acceptable.
- **Schema-version proliferation.** Forty events deep into v2, schema versions of individual events may diverge. Reducer becomes a multi-branch dispatcher. Mitigation: document each event in `docs/architecture/events.md`; CI test asserts no event kind has more than 3 live schema versions (force consolidation).

## Alternatives considered

| Alternative | Rejected because |
|---|---|
| **Stay on mutable JSON + better locks (ADR-0002 alone)** | Solves the race but not the auditability / replay / multi-goal merge problems. Cost of full refactor pays for itself within first 6 months of v2 work. |
| **SQLite as event log** | Adds a native dep. Claude Code's `/plugin install` does not run `npm install`; we'd ship `better-sqlite3` prebuilt binaries per platform. Build-and-distribute cost too high. Append-only JSONL gives us 90% of what SQLite would give us at 5% of the cost. |
| **Git as event log (one commit per event)** | Conceptually appealing (immutability, history built-in) but the user's git repo is for *their* code; goal-mode state shouldn't pollute it. A second git repo nested under `.claude/goals/` adds operational complexity (cleanup on `/goal-clear`, ignored paths, etc.). |
| **Redux-style with explicit diffs** | Diff format is essentially what events.jsonl already is; the only difference is whether the payload is `{ kind: 'add-evidence', ... }` (event) or `{ op: 'add', path: '/tree/root/.../evidence/0', value: { ... } }` (RFC 6902 diff). Event style is more semantic and aligns better with the existing tag taxonomy. |
| **External event store (Kafka, NATS, etc.)** | A Claude Code plugin runs in a single Node process per Stop hook. Out of scope. |

## Migration

The migration must be **non-destructive**: any v1.x user who upgrades to v2.0.0 must see their existing goal behave identically, and they must be able to downgrade back to v1.x with `git reset --hard <prev>` and have their state still load.

### Phase A — `v2.0.0-rc1` (event log alongside)

1. Engine writes events.jsonl AND continues to maintain tree.json / state.json (dual write).
2. Reads still come from tree.json / state.json (no behavior change).
3. New regression test: "after every CLI call and every Stop hook turn, replay events.jsonl from scratch and assert the result matches the on-disk tree+state byte-for-byte".
4. Ship as 2.0.0-rc1. Test against Mancelot's live goal.

### Phase B — `v2.0.0-rc2` (events become canonical)

1. Engine writes events.jsonl as primary; tree.json + state.json become caches in `derived/`.
2. Reads come through reducer; cache is a fast path.
3. CLI invariant: cache may be deleted at any time, reducer reconstructs.
4. Ship rc2. Mancelot continues.

### Phase C — `v2.0.0` (cache simplification)

1. Remove dual-write code; only reducer maintains caches.
2. Snapshot strategy active.
3. Existing-goal upgrade script: `node engine/migrate-v1-to-v2.mjs` reads old `active/{tree,state}.json` and synthesizes a believable initial event sequence (`goal-created`, `plan-approved`, `started`, then synthetic catch-up events to bring state forward). Migration is idempotent (running twice produces same events).

### Phase D — `v2.1.0+`

1. Remove migration script (deprecated path).
2. Introduce optional event-stream consumers (e.g., real-time `/goal-status` watcher).

## Open questions

- **Q1.** Snapshot retention policy default. Proposed: keep all within 7 days OR last 100 events, whichever bound is larger. Revisit after first 30 days of real usage.
- **Q2.** Event ID format. ULID gives sortable + unique. Alternative: monotonic counter (simpler, smaller). Decision deferred to plan-D1 phase 0.
- **Q3.** Should `iteration-began` carry the FULL transcript text for forensics, or just the path? Storage cost vs. forensic value. Initial decision: just the path; full text recoverable from session JSONL.
- **Q4.** Event compaction (similar to git pack) — when events.jsonl exceeds 10MB, can we rewrite it as the latest snapshot + tail events? Deferred to post-v2.0.0.
- **Q5.** Cross-goal event stream (single `~/.claude/goal-mode/events.jsonl` for all goals) — interesting for observability, but conflicts with per-goal isolation. Deferred to ADR-0003 implementation review.

## References

- Martin Fowler, *Event Sourcing* (2005). https://martinfowler.com/eaaDev/EventSourcing.html
- Greg Young, *CQRS Documents* (2010).
- `engine/state.mjs` — current schema definitions (v1.1.x)
- `engine/apply-mutations.mjs` — current mutation logic (target of refactor)
- `engine/stop-hook.mjs` — current Stop-hook orchestrator
- ADR 0002 (concurrent sessions lock) — complementary, ships first
- ADR 0003 (multi-goal namespace) — depends on this
- ADR 0004 (plan-as-code DSL) — independent but emits `goal-created` events through this layer
