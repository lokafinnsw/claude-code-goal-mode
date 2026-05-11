# ADR 0002 — Concurrent session locking

- **Status:** Proposed
- **Date:** 2026-05-10
- **Tags:** v2.0.0, refactor, breaking-change-internal, concurrency
- **Supersedes:** None
- **Original label:** D2 (v2 brainstorm 2026-05-10)

## Context

Goal-mode runs Node processes that mutate shared state on disk: the Stop hook (invoked by Claude Code on every turn) and N CLI scripts (`pause`, `resume`, `clear`, `abandon`, `approve`, `manual-approve`, `approve-plan`, `start`). Today all of these read state.json, compute a mutation, and write state.json — with no synchronization between them.

Three concrete race scenarios exist in v1.x:

### Race 1: Stop hook vs. CLI script (same session)

```
T+0    Stop hook starts: loadState() → state.lifecycle = 'pursuing'
T+50ms User in another terminal: /goal-pause → loadState() → 'pursuing'
T+60ms                          /goal-pause → state.lifecycle = 'paused' → saveState()
T+200ms Stop hook completes applyMutations against the in-memory 'pursuing' snapshot
T+210ms Stop hook saveState() with lifecycle='pursuing' → user's pause silently lost
```

The Stop hook re-writes the entire state object, overwriting the pause. The Stop hook also returns a continuation block decision to Claude Code, so Claude continues working as if pause never happened. The user sees their pause "didn't take" with no error message.

### Race 2: Stop hook vs. Stop hook (cross-session, same project)

ADR 0001's session-id binding handles **deliberate** cross-session interference (Stop hook bails if `state.session_id !== stdin.session_id`). But during the window where one session calls `/goal-start` (resetting `session_id`) and another session's Stop hook is mid-flight, the bailout check may pass (loaded state's old session_id matched) but the write at the end clobbers the new session_id.

### Race 3: Stop hook vs. external user (manual file edit)

A user inspecting `.claude/goals/active/state.json` in their editor saves a tweak (e.g., manually adjusts `budget.iterations.max`) — Stop hook running concurrently overwrites that tweak. No locking, no detection.

### What ADR 0001 (event log) fixes vs. doesn't

The event-log refactor (ADR 0001) makes the **write primitive** atomic: appending a single JSON line to `events.jsonl` is atomic on POSIX (within PIPE_BUF). Two processes appending concurrently produce two events in some order, neither corrupted. **But:** the *semantic* operation a CLI script performs is "read current state → decide what to do → emit event(s)". The read-decide-emit sequence is still not atomic; the read can happen against a state that a concurrent process is about to change.

Example post-ADR-0001 race:

```
T+0    /goal-pause reads state → lifecycle='pursuing'
T+50ms Stop hook reads state → lifecycle='pursuing'; emits 'cursor-advanced' event
T+100ms /goal-pause emits 'lifecycle-changed' (pursuing → paused) event
```

Both events are written cleanly to events.jsonl. The reducer processes them in order. But the **semantic** intent of `/goal-pause` was "pause whatever the cursor currently is" — and by the time the event lands, the cursor has moved. The user is now paused on the WRONG task.

**Conclusion:** event-log atomicity protects the data structure, but the **read-decide-write logical operation needs serialization**. We need an explicit lock.

## Decision

Introduce a **file-based advisory lock** on the per-goal namespace (`.claude/goals/<goal-id>/.lock`). Every write-intent operation acquires the lock, performs its read+decide+emit, and releases. Reads alone do not lock (consistent with event-log semantics: snapshot + tail replay is always safe).

### Lock primitive

`engine/lock.mjs` exports a small API:

```js
acquireLock(goalDir, intent: string, opts?: { timeoutMs?: number, force?: boolean }): Promise<LockHandle>
releaseLock(handle: LockHandle): void
isLocked(goalDir): { locked: boolean, holder?: LockInfo, stale: boolean }
breakStaleLock(goalDir, reason: string): boolean  // returns true if broken
```

`LockInfo` shape (JSON written into the .lock file):

```json
{
  "schema_version": 1,
  "pid": 12345,
  "session_id": "session-abc",
  "intent": "stop-hook-tick" | "goal-pause" | "goal-resume" | "goal-clear" | ...,
  "acquired_at": "2026-05-10T15:30:00.000Z",
  "ttl_seconds": 30,
  "host": "macbook.local"
}
```

### Acquisition protocol

1. Open `.lock` exclusively (`fs.openSync(path, 'wx')`). On EEXIST:
2. Read existing lock. If `pid` is alive on this host (`process.kill(pid, 0)` succeeds) AND `now - acquired_at < ttl_seconds`, lock is held — go to step 3. Otherwise lock is stale — break it and go to 1.
3. Wait exponential backoff (100ms, 200ms, 400ms, 800ms, capped at 1600ms; jitter ±25%). After total `timeoutMs` (default 5000ms) elapsed, throw `LockTimeoutError`.
4. On successful exclusive open: `fs.writeSync` the LockInfo JSON, `fs.closeSync`. Return `LockHandle = { lockPath, pid, acquired_at }`.

### Release protocol

1. Read `.lock`. If `pid` matches handle, delete the file. If not (someone else owns it now — bug), log a warning to stderr and do nothing.

### Process-exit safety

Every CLI script and the Stop hook register a `process.on('exit')` and `process.on('SIGTERM')` cleanup that calls `releaseLock` for any held handle. The lock-info `pid` field is the safety net for the cases where signal handlers don't fire (SIGKILL, OOM).

### Cross-host caveat

The `process.kill(pid, 0)` liveness check is **host-local**. If two hosts share the project directory (NFS, SMB, etc.), a PID from another host can appear "dead" here. Lock info includes `host` (hostname); if `host !== os.hostname()`, the local liveness check is skipped — the lock is treated as held until TTL expires. This is the conservative choice: prefer waiting over breaking a possibly-live remote lock.

### Use sites

Every write-intent path acquires the lock at entry. Read-only paths (`/goal-status`, `loadState`, `loadTree`) do NOT acquire. Specifically:

| Site | Acquires? | Intent string |
|---|---|---|
| `engine/stop-hook.mjs` runStopHook | ✅ | `stop-hook-tick` |
| `engine/start-goal.mjs` startGoal | ✅ | `goal-start` |
| `engine/approve-plan-cli.mjs` | ✅ | `approve-plan` |
| `engine/lifecycle-commands.mjs` pause/resume | ✅ | `goal-pause` / `goal-resume` |
| `engine/abandon-cli.mjs` | ✅ | `goal-abandon` |
| `engine/clear-cli.mjs` | ✅ | `goal-clear` |
| `engine/manual-approve.mjs` | ✅ | `manual-approve` |
| `engine/render-status.mjs` | ❌ | (read-only) |
| `engine/transcript.mjs` readLastAssistantText | ❌ | (read-only) |

The Stop hook holds the lock for the entire `applyMutations + emit events + save derived` sequence (~50–200ms typical). Long-held locks (>5s) are an error indication; CI test asserts no test case holds the lock longer than 1s.

## Consequences

### Positive

- **Race 1, 2, 3 all eliminated.** All write paths serialize through one lock per goal.
- **Failure observability.** Stale lock detection logs to stderr with the holder PID — diagnosing a hung Stop hook becomes "look at .lock, see PID, check process".
- **Cross-session pause works.** User in terminal A runs `/goal-pause`; user's other session's Stop hook waits up to 5s, then either honors the now-paused state or times out (in which case the user sees a clear "lock held" message and can investigate).
- **Manual file edits race-safe.** If a user manually edits `state.json` via text editor, the next CLI script call will read their edit; their edit is not silently overwritten (the lock protects the write window).

### Negative

- **Lock contention adds latency.** Best case: 1 fs open syscall (~0.1ms). Worst case (contention): up to 5s wait. The 95th percentile in practice should be <100ms because Stop hooks complete in 50–200ms.
- **Stale lock heuristic is heuristic.** Wrong-host PIDs are conservative (wait until TTL expires). Wrong-pid (PID reuse) is theoretically possible but extremely unlikely within a 30s TTL.
- **One lock per goal.** With ADR-0003 (multi-goal), each goal has its own .lock. Stop hook on Goal A doesn't block CLI on Goal B. This is correct, not a defect.
- **No cross-process condvar.** A waiting CLI script polls (backoff sleep). Not blocking on a kernel primitive. ~5–10ms of polling overhead in the contended case. Acceptable for a 5s worst-case wait.

## Alternatives considered

| Alternative | Rejected because |
|---|---|
| **OS-level `flock(2)`** | Not portable to Windows. `proper-lockfile` npm package wraps this but adds runtime dep. Build-it-yourself in ~80 lines of Node. |
| **Use events.jsonl append as the locking primitive** | Atomic append protects single events. But the read-decide-emit sequence in CLI scripts spans multiple operations. Append-atomicity alone isn't sufficient. |
| **Optimistic concurrency (version field in state, CAS on save)** | Would require teaching every CLI script to retry on conflict. Cumulative complexity exceeds explicit lock. |
| **No locking, rely on session-id binding alone** | session-id binding only protects against cross-session Stop-hook fires. Doesn't help CLI scripts or single-session races between Stop-hook and a same-session terminal action. |
| **Lock-free design with conflict-free replicated data types (CRDTs)** | Goal state has total order semantics (cursor advances, lifecycle transitions). CRDT-style merge would force us to invent semantics for "concurrent pause and advance" — that semantic doesn't exist in user mental model. |

## Migration

ADR-0002 is **backward-compatible** and ships independently of ADR-0001. The lock file lives alongside existing state; legacy v1.x code that doesn't acquire the lock simply doesn't get serialization protection — but doesn't break either.

### Phase A — `v1.x → v1.x+1` (additive)

1. Introduce `engine/lock.mjs`. No CLI scripts wired yet.
2. Tests: unit tests for `acquireLock`, `releaseLock`, `isLocked`, `breakStaleLock`, including contention scenarios and stale-lock breakage.
3. Ship as a minor version bump (1.2.0). No user-visible behavior change.

### Phase B — `v2.0.0-rc` (wire into all write sites)

1. Each of the 8 write-intent sites acquires the lock at entry. Tests added to verify contention behavior end-to-end.
2. Stop hook timing: 95th percentile lock-hold-time tracked in stderr log (for diagnosis); CI test asserts <500ms in test fixtures.
3. Migration of running Mancelot goal: continues to work because the lock primitive is additive — no behavior changes for non-contended paths.

### Phase C — `v2.0.0`

1. Hardening pass: lock contention metrics exposed via `/goal-status` (debug mode).
2. Lock-troubleshooting docs in `docs/TROUBLESHOOTING.md`.

## Open questions

- **Q1.** Default TTL value. Proposed: 30 seconds. Long enough for any honest Stop hook to complete; short enough to recover from crashes quickly. Revisit after measuring real Stop-hook latencies post-D1.
- **Q2.** Should `/goal-status` print "🔒 lock held by PID X" when the lock is held during a status call? Useful for observability but might confuse users seeing a transient message. Default: only show in `--verbose` mode.
- **Q3.** When `breakStaleLock` is called, do we emit a `lock-broken` event into events.jsonl? Yes — auditability. Belongs in the ADR-0001 event taxonomy.
- **Q4.** What happens when the lock file IS stale but the new acquirer detects mid-acquire that the original holder revived (TOCTOU)? Resolution: acquire is atomic via `wx` open mode; if file appeared between liveness check and open, we get EEXIST and restart the loop. Worst case: one extra retry.
- **Q5.** Should we expose `/goal-unlock` as an emergency CLI? Yes, defer to Phase C. Body: `breakStaleLock` with `--force` and an audit event.

## References

- `proper-lockfile` (npm) — close cousin of this design; not adopted because we don't want the dep.
- Linux `flock(2)` man page — semantics we approximate.
- ADR 0001 (event log) — complementary; this ADR ensures the *operation* writing events is serialized, while ADR 0001 ensures the events themselves are written atomically.
- `engine/stop-hook.mjs` — primary lock site
- `engine/apply-mutations.mjs` — what the lock protects
