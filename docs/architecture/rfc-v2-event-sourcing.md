# RFC: v2.0.0 — Event log as source of truth

**Status:** Draft (2026-05-11). Not yet approved for implementation.
**Author:** goal-mode controller, reviewed against v1.2.0 self-critique D1.
**Target release:** 2.0.0 (major bump — breaking changes to on-disk format and engine surface).

## 1. Why this RFC exists

v1.2.0 introduced an append-only event log (`events.jsonl`) as a **dual-write**
secondary to the imperative `state.json` + `tree.json` mutation path. v1.2.1
fixed replay completeness so that `state-from-events.mjs::replayEvents()` can
reconstruct a state byte-equivalent to what `saveState()` would produce.

The dual-write architecture is a transitional design. It has three structural
problems that no patch can close:

1. **Two sources of truth.** `state.json` says one thing; `events.jsonl` says
   another. The "engine встал" bug class was rooted in this: a partial save
   to `state.json` left disk inconsistent with the event log. We added
   atomic-write order (events first, state second) in v1.2.1 to prefer
   events on crash, but **state.json is still authoritative on every read**.
   Reading code never consults the event log.

2. **Imperative mutations are unaudited.** `applyMutations` directly writes
   to `tree.evidence[].push(...)`, `node.status = ...`, `state.history.push(...)`.
   Any non-stop-hook code path that bypasses `applyMutations` (manual `jq`
   patches, lifecycle commands, `start-goal.mjs`'s direct save) skips the
   event log entirely. We've seen this firsthand: when the user `jq`-patched
   `state.session_id`, no event recorded the rebind until v1.1.19 was
   shipped. Each new mutation site is a new audit gap.

3. **No replay-based recovery in the hot path.** v1.2.1 wires
   `loadStateWithRecovery()` for the case of a missing/corrupt state.json,
   but the normal `loadState()` never touches events. Two practical bugs
   sneak past this:
   - Lost trailing events: stop-hook crashes after appending events but
     before saveState. Next loadState reads the stale state and silently
     loses the events.
   - Inconsistent snapshot: state.json claims `cursor=A`, but events show
     a later `cursor-advanced` to `B`. No mechanism reconciles.

v2.0.0 inverts the relationship: **`events.jsonl` becomes the canonical
source of truth, `state.json` becomes a regenerable cached view**. Every
mutation path must emit events; reads can either replay events (always
correct, possibly slow) or load the latest cached snapshot (fast, eventually
consistent). The cache is regenerated after every mutation, so eventual
consistency converges within one Stop hook fire.

This is a classic event-sourcing pattern. The reference implementations
(Kafka Streams, EventStoreDB, Axon Framework, ksqlDB) share the same shape:
log + projections + snapshots + sequence guarantees. We will steal what
applies and ignore what doesn't (we have no distributed concerns —
single-node, file-system-backed, with at-most-two concurrent writers).

## 2. Design principles

**P1. Append-only is non-negotiable.** `events.jsonl` never edits
existing lines. The only write operation is `appendFileSync(line + '\n')`.
This is what gives us atomic appends at the OS level on POSIX
(`O_APPEND | O_WRONLY`).

**P2. Every mutation emits an event.** No engine code path mutates `state.json`
or `tree.json` outside of `regenerateCache(eventsPath, snapshotPath)`. This
is enforced by code review and by deleting the imperative paths in
`apply-mutations.mjs` after migration.

**P3. State is a function of events.** `state = replay(events.from(genesis))`.
A snapshot is a memoised checkpoint of this function evaluated at a
particular sequence number. Loading state always answers the question
"what does the event log say?", never "what did some previous writer leave
in this file?".

**P4. Determinism is testable.** `replay(events)` is a pure function. Any
sequence of events produces the same state, on any machine, at any time.
This is the contract that lets us cache and rebuild fearlessly.

**P5. Concurrent writers must serialise.** Two CC sessions in the same
project = two writers of `events.jsonl`. We need a lock or sequence
arbitrator to avoid lost updates. We'll use a PID-based advisory file lock
with stale-detection.

**P6. Backward compatibility = roll-forward only.** v2.0.0 reads v1.x
projects, migrates them once at first load (synthesises events from
`state.history`), then operates as v2 forever. There is no automatic
v2→v1 downgrade path.

## 3. Event vocabulary (final)

Closed enumeration. Adding new kinds is a minor bump (event-schema migration).

| Kind | Trigger | Payload |
|---|---|---|
| `goal-created` | `/goal-plan` or `/goal-plan-from-file` saves the initial tree | `goal_id`, `mission`, `tree` |
| `goal-approved` | `/goal-approve-plan` | `goal_id`, `approved_at` |
| `goal-started` | `/goal-start` | `goal_id`, `session_id`, `cursor`, `started_at`, `budget` |
| `evidence-recorded` | `<evidence>` tag | `node_id`, `criterion`, `file`, `line`, `command`, `exit_code`, `note` |
| `task-status-set` | `<task-status>` tag (when status changes a node) | `node_id`, `from`, `to`, `reason` |
| `review-requested` | `<review-request>` tag | `node_id`, `agents` |
| `review-verdict-accepted` | `<audit-verdict>` with valid Agent dispatch | `node_id`, `agent`, `status`, `text` |
| `review-verdict-rejected` | `<audit-verdict>` without valid Agent dispatch | `node_id`, `agent`, `status`, `text`, `reason` |
| `cursor-advanced` | After all reviewers GO or empty review on achieved | `from`, `to`, `reason` |
| `blocker-set` | `<task-status>blocked</task-status>` | `node_id`, `reason` |
| `lifecycle-changed` | Lifecycle transitions (pursuing/paused/achieved/unmet/budget-limited) | `from`, `to`, `reason`, `ended_at?` |
| `session-rebound` | Auto-rebind on Stop hook session mismatch | `old_session_id`, `new_session_id`, `reason` |
| `budget-tick` | Once per Stop hook fire | `iterations_used`, `tokens_used`, `wallclock_seconds`, `session_id` |
| `manual-override` | `/goal-approve` (manual GO) | `node_id`, `reason` |
| `goal-cleared` | `/goal-clear` (terminal) | `goal_id`, `archived_to?` |

Each event has:
- `event_id` — uuid v4
- `event_schema_version` — int, starts at 1
- `ts` — ISO 8601 timestamp (wall-clock, info only)
- `seq` — int64 monotonic sequence within this goal (guarded by lock — see §6)
- `turn_id` — uuid v4, groups events emitted in the same Stop hook fire (for transactional grouping)
- `kind` — enum from above
- `payload` — kind-specific zod-validated object

`ts` is informational; replay sorts by `seq`. The lock guarantees `seq` is
globally monotonic per goal.

## 4. Storage layout

```
.claude/goals/active/
  events.jsonl              # append-only log, canonical source of truth
  state.json                # CACHED snapshot — regenerated on every write
  tree.json                 # CACHED tree (plan immutable, per-node state derived)
  snapshots/
    snap-<seq>.json         # full {state, tree} checkpoint at seq N
    snap-<seq>.meta.json    # { genesisSeq, lastSeq, eventCount }
  .lock                     # PID-based concurrent-writer guard
  audits/<existing>
  notes.md                  # human-readable digest, additive only
.claude/goals/archive/
  goal-<id>-<ts>/           # cleared goals archived here on /goal-clear --archive
  events-<batch>.jsonl      # rotated old events (rotation policy: every 500 events)
```

`events.jsonl` is **never truncated, never rewritten**. Rotation moves the
oldest 250 events to `archive/events-<batch>.jsonl` when active exceeds 500.
This is the same model as v1.2.1's rotation but tightened thresholds.

`snapshots/` is regenerable from `events.jsonl` plus any older snapshot.
Snapshot-creation triggered by:
- Every `cursor-advanced` event (natural milestone, ~10-100×/goal)
- Every 50 events (safety net for long stretches without cursor advance)
- On `goal-cleared` (final snapshot for archive)

Snapshot retention: keep last 5; older deleted on next snapshot creation.

`state.json` and `tree.json` exist for backward-compat (existing tooling
greps them, doctor checks them). They are **derived from the latest snapshot
plus tail events** on every write. **No code reads them as source of truth
in v2.0.** Doctor surfaces a warning if their content diverges from the
event-derived state (impossible if engine is healthy, but a corruption canary).

## 5. Read path

```
loadCurrentState(projectRoot):
  1. Acquire shared read lock (multiple readers ok).
  2. Read latest snapshots/snap-<N>.json. If absent, start from genesis.
  3. Read events.jsonl from snapshot's lastSeq+1 to end.
  4. Run replay(snapshot.state, snapshot.tree, tailEvents) → currentState.
  5. Release lock.
  6. Return currentState.
```

Performance: snapshot lookup is O(1), tail replay is O(tailLength) where
tailLength ≤ 50 by snapshot policy. Median load: ~5-15ms even at 10k+
total events. Compare v1.2.x: `loadState()` reads + zod-validates `state.json`
in ~1-2ms. Read-path cost increases ~5x — acceptable given the guarantees.

Optimisation: cache the loaded state in memory for the duration of a single
process (Stop hook lifetime). The hook reads once at start; writes once at
end; no re-reads needed.

## 6. Write path

```
appendTurnEvents(projectRoot, turnEvents):
  1. Acquire exclusive write lock (single writer at a time).
     - Try fs.openSync('.lock', 'wx').
     - If exists, read PID. If process alive AND lock-age < 60s, abort
       with "another session is driving this goal".
     - Stale lock (dead PID or > 60s old) → take over.
  2. Read max(seq) from events.jsonl (lazy: only the last line).
  3. Stamp turnEvents with monotonic seq + same turn_id.
  4. Append all events in a single appendFileSync(buffer). Atomic at OS level.
  5. Regenerate cached state.json + tree.json from new state.
  6. Maybe create new snapshot (if cursor-advanced in this turn, or
     event count since last snapshot > 50).
  7. Release lock.
```

Atomicity boundary: step 4. If a crash happens before step 4, no events are
persisted (since step 4 is a single syscall, it either writes all or none —
on POSIX this is true for writes up to `PIPE_BUF` bytes; we keep turns
small enough to be safe).

If a crash happens between step 4 and step 5, the cache is stale. Next
`loadCurrentState` reads the latest snapshot, replays tail events (which
include the just-written ones), produces the correct state, and rewrites
the cache. Self-healing.

## 7. Concurrent writers — lock semantics

The Mancelot real-world case: Desktop session + CLI session both open in
the same project, both fire Stop hooks.

Without a lock:
```
T1: Desktop reads max(seq)=10, computes events with seq=[11,12,13]
T2: CLI reads max(seq)=10, computes events with seq=[11,12]
T1: writes [11,12,13]
T2: writes [11,12]  ← seq collision
```

With the lock:
```
T1: Desktop acquires lock. Reads max(seq)=10.
T2: CLI tries to acquire lock → exists, PID alive → aborts with stderr message.
T1: Writes [11,12,13]. Releases lock.
T2: Next Stop hook fires. Acquires lock. Reads max(seq)=13. Writes [14,15].
```

Lock contents:
```json
{
  "pid": 12345,
  "session_id": "uuid",
  "acquired_at": "2026-05-11T12:00:00.000Z"
}
```

Stale detection: PID not in `/proc` (Linux) / `kill -0` (macOS) → take over.
Mtime > 60s → take over (covers crashed-process case where PID was reused).

Aborted hooks (lock-held) emit a stderr message and return null stdout —
visible to user via the v1.2.0 "error-as-prompt" diagnostic surface.

## 8. Migration v1.x → v2.0

First load of a v1.x project under v2.0:
1. Detect: `events.jsonl` absent OR has no `goal-created` event.
2. Read `state.json` + `tree.json` (v1.x source of truth).
3. Synthesize events from `state.history`, mapping each entry to its v2
   event kind. Stamp with `synthesized_from_v1: true` in payload, `seq`
   1..N in original order.
4. Append `migration-applied` event (new kind, marker only).
5. Generate initial snapshot from the v1.x state/tree pair.
6. Operate as v2 from then on.

Information loss: v1.x `state.history` has narrower payloads than v2 events.
Migrated events have minimal information but are sufficient for future
replay. Original `state.json` is preserved as `state.json.pre-v2-migration-<ts>`.

Doctor check `v2-migrated`: reports whether the project has the
`migration-applied` event (yes = ok), is fresh v2 (yes = ok), or appears
to be a v1.x project that hasn't been migrated (warning).

CLI flag `--migrate` on `loadCurrentState` (default: auto-migrate on first
load). User can opt out with env var `GOAL_MODE_NO_AUTO_MIGRATE=1` if they
want to inspect first.

## 9. Open questions

**Q1. How small is a "turn"?**
A turn must fit in a single appendFileSync for atomicity. POSIX guarantees
atomic writes ≤ `PIPE_BUF` bytes (typically 4096). At ~200 bytes/event,
that's ~20 events per turn — generous. Worst case (e.g., 30 evidence tags
in one turn): write in two appends, accept that crash between yields a
partial turn that replay can detect via turn_id.

**Decision needed:** strict single-append atomic turns (impose 20-event limit
per turn), OR multi-append turns with replay-side partial-turn detection
(more code, no hard limit).

**Q2. What if event-schema migration is needed?**
We've left `event_schema_version` as a per-event field. If we ever need
to rename a payload key, migration framework like `engine/migrations/` but
per-event. Add only when needed.

**Q3. How to handle clock skew?**
`ts` is wall-clock, used only for human display + audit forensics. `seq`
is the order-of-record arbiter. NTP adjusting time backward will only
make `ts` non-monotonic; replay correctness depends on `seq` only.

**Q4. Snapshot retention vs disk space?**
5 snapshots × ~50 KB each = 250 KB per goal. Negligible. Archive cleanup
on `/goal-clear --archive` moves everything to archive/, keeps active small.

**Q5. Replay correctness invariant?**
We need a property test: for any v1.x project (state + tree + history),
synthesizing events and replaying them must produce a state where
`state.cursor`, `tree.<node>.status`, `tree.<node>.evidence` agree with
the v1.x source. We'll generate randomised fixtures and assert this
invariant in CI.

**Q6. What happens if events.jsonl itself becomes corrupt?**
Malformed lines are skipped during replay (with stderr warning) — same
graceful-degradation policy as v1.2.x. Replay produces best-effort state.
Doctor surfaces "N events skipped during last load" if any. Recovery is
manual: copy `archive/events-<batch>.jsonl` back, replay, accept the
synthesized state.

**Q7. Backward compat for tooling that writes `state.json` directly?**
There is no such tooling in our control — but users may `jq`-patch state
manually (as we saw in mancelot). Under v2, that patch is discarded on
next load because state is regenerated from events. The cure: a doctor
check `direct-state-patch-detected` that compares `state.json` against
the replayed state at load time and warns when they diverge. If user
genuinely needs to mutate, provide `/goal-mode:goal-emit-event` (new
escape-hatch command in v2.0).

## 10. Risk analysis

| Risk | Severity | Mitigation |
|---|---|---|
| Replay produces wrong state for some v1.x history pattern we didn't anticipate | High | Property-based test that runs every v1.x state.history through replay and asserts state equivalence; 100+ test projects synthesized. |
| Lock contention blocks legitimate concurrent work | Medium | Aggressive stale detection (60s max); clear stderr message; instructions in continuation prompt to coordinate. |
| Snapshot creation introduces non-trivial latency | Medium | Snapshot is async-ish: we write events first (fast), then snapshot before releasing lock. Worst-case ~50ms for 10k events. Acceptable. |
| Migration from v1.x produces a state that diverges from the original at the byte level | Low | Per-task assertion: tree.evidence array contents must match. State.cursor and lifecycle must match. Subtle diffs in counters acceptable. |
| Users on v1.x with goal-mode already shipped in production can't upgrade smoothly | High | Migration is automatic and one-way; `state.json.pre-v2-migration-<ts>` preserved as backup. Doctor check `v2-migrated` surfaces transition state. |
| Append after a corrupted line in events.jsonl produces invalid log | Medium | On every append, validate the tail of events.jsonl is JSON-parseable; if not, abort with a clear "events.jsonl has corruption at line N; recover from archive or run /goal-mode:goal-doctor --repair-events" message. |
| Event log grows unbounded across goal lifetime | Low | Rotation policy (move oldest 250 to archive when active > 500) keeps active small. Total disk usage grows linearly but is bounded per-goal. |
| Concurrent reader sees half-written line during another writer's append | Low | POSIX append + write up to PIPE_BUF is atomic; lines longer than that are written via two appends but each line is one append. Newline separator means reader can detect partial line and skip. |

## 11. Implementation plan (8 epics, ~40 tasks)

See `tree.json` artifact in `docs/architecture/rfc-v2-tree.json` for the
formal plan-tree (will be created when this RFC is approved and we are
ready to start v2.0.0 implementation).

Epic outline:
1. **Event schema hardening** — full vocabulary + zod schemas + tests
2. **Replay engine SOTA** — primary read path, snapshot generation, property tests
3. **State-as-cache refactor** — invert `saveState`/`loadState` to derive from events
4. **Concurrent-writer lock** — PID lock, stale detection, contention tests
5. **Migration v1.x → v2.0** — automatic, one-way, preserves backup
6. **Performance & compaction** — snapshot policy, replay benchmarks, large-log tests
7. **Backward compat & escape hatches** — `/goal-mode:goal-emit-event`, doctor v2-migration check
8. **Integration + release** — version bump to 2.0.0, README rewrite, migration guide, full E2E

## 12. Acceptance criteria for v2.0.0

The release is shipped when:
- All v1.2.1 test suites pass under v2 engine (compatibility surface preserved)
- Property test: 100 randomised v1.x histories replay to byte-identical state
- Concurrent-writer test: 2 simultaneous Stop hook fires never produce seq collisions
- Crash injection test: 100 random throws in stop-hook recovery rebuilds correct state
- Replay benchmark: 10k events load in < 100ms (warm cache)
- Migration test: every example plan in `docs/EXAMPLES/` migrates from v1 to v2 without state diff
- Self-meta-test: bootstrap v2.0.0 plan as a goal-mode goal on the goal-mode repo itself (continued "goals on goals")

## 13. Non-goals for v2.0.0

These are deliberately out of scope:
- Multi-goal namespace (D4 from v1.2.0 critique) — separate v2.1 epic
- Plan-as-code TypeScript (D5) — separate v2.x epic
- Cross-/compact cumulative token tracking (D3) — needs CC API support first

These remain in the backlog but do not block v2.0.0.

## 14. Decisions required before implementation

Before opening Epic 1, the following decisions need explicit user (or
team) sign-off:

1. **Strict single-append turns (Q1).** Default: yes, enforce ≤ 20 events per
   turn, abort otherwise. Alternative: multi-append with partial-turn detect.
2. **Snapshot trigger policy (§4).** Default: cursor-advanced OR every 50
   events OR goal-cleared. Alternative: time-based (every 5min).
3. **Lock stale threshold (Q-§7).** Default: 60s. Alternative: configurable.
4. **Migration auto-run (§8).** Default: yes, auto on first load. Alternative:
   require explicit `/goal-mode:goal-migrate-to-v2` invocation.
5. **`state.json` legacy preservation (§4).** Default: keep as cached
   snapshot for tooling compat. Alternative: remove entirely.
6. **Event schema versioning (§3, Q2).** Default: per-event `event_schema_version`
   field, migration framework only added when first needed. Alternative:
   single global event-schema-version that bumps for any change.

Once those are answered, implementation begins and is mechanical.
