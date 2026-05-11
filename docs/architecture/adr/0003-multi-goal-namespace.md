# ADR 0003 — Multi-goal namespace

- **Status:** Proposed
- **Date:** 2026-05-10
- **Tags:** v2.0.0, refactor, breaking-change, file-layout
- **Supersedes:** None
- **Depends on:** ADR 0001 (event log), ADR 0002 (locking)
- **Original label:** D4 (v2 brainstorm 2026-05-10)

## Context

v1.x supports exactly one active goal per project, with finished goals snapshotted into `.claude/goals/archive/<date>-<slug>/`. The `engine/paths.mjs` API hardcodes a single path namespace:

```js
export const activeDir = (root) => path.join(goalsDir(root), 'active');
export const treePath = (root) => path.join(activeDir(root), 'tree.json');
// ... etc
```

This worked through v1.x but blocks several real workflows we now hit:

### Workflow 1: Interleaved long-running + quick goals

The Mancelot project currently has an active 800-iteration "MVP roadmap" goal. While that runs, the user occasionally needs to interrupt and run a 5-task quick goal (e.g., "land that bug fix before tomorrow's playtest"). Today: only by `/goal-pause` on the long goal, `/goal-clear` it (losing context), running the small goal, then re-planning the long one. Lossy and tedious.

### Workflow 2: Parallel goals on independent work fronts

Mancelot has two work fronts active simultaneously: "engine MVP" and "narrative pass". Both are 100+ task goals. Today they'd have to be sequenced strictly; with parallel goals they could each have their own cursor and budget, sharing only the project's codebase and review-agent inventory.

### Workflow 3: Cross-goal visibility

A status command that shows "what is goal-mode currently doing on this machine" — across all goals in all projects — is impossible today. Each project has its own .claude/goals/active/, and active is hardcoded as a single path. A `/goal-list` command listing every goal (active or archived) across projects requires a known cross-project namespace.

### Workflow 4: Goal templating and forking

If two goals share 80% of their plan (e.g., one is a derivative of the other), today the only path is manual JSON copying. A first-class "fork goal X to new goal Y" command needs a namespace where Y can be created without disturbing X.

### Why ADR 0001 (event log) and ADR 0002 (locking) are pre-requisites

- **ADR 0001:** Each goal needs its own event log. Sharing a single events.jsonl across goals couples goal lifecycles and complicates the reducer. Per-goal events.jsonl is the natural shape — and depends on having a per-goal directory.
- **ADR 0002:** Each goal needs its own lock. Stop hook on Goal A must not block CLI calls on Goal B. Per-goal `.lock` requires per-goal directory.

This ADR is **downstream of** both. It can ship anytime after they're in (Phase B of each).

## Decision

Refactor the file layout to a **per-goal namespace** with a single **active pointer**:

```
.claude/goals/
├── .active                              ← contains the goal_id of the active goal (or empty/missing if none)
├── <goal-id-1>/                         ← per-goal namespace (was: active/)
│   ├── events.jsonl                     ← (ADR 0001)
│   ├── snapshots/                       ← (ADR 0001)
│   ├── derived/                         ← (ADR 0001)
│   │   ├── tree.json
│   │   └── state.json
│   ├── plan.md
│   ├── notes.md
│   ├── audits/
│   └── .lock                            ← (ADR 0002)
├── <goal-id-2>/
│   └── ...                              ← (same shape, archived or live)
└── <goal-id-N>/
```

### Lifecycle change: archive → archived-bit

In v1.x, an "archived" goal lives in `.claude/goals/archive/`. In v2 there's no separate archive directory — every goal is in its own `<goal-id>/` directory, and "archived" is a state derived from the goal's lifecycle (terminal: `achieved`, `unmet`, `budget-limited`, `cleared`).

The `.active` pointer is the only way the engine knows "which goal does the Stop hook drive when a turn ends". A terminal-lifecycle goal can never be the active one — `/goal-start` refuses to point `.active` at a terminal goal. To "revive" an archived goal for further work, the user runs `/goal-fork <id> --as <new-id>` which copies its state forward into a new namespace.

### Path API change

`engine/paths.mjs` grows a mandatory `goal_id` parameter:

```js
export const goalDir = (root, goalId) => path.join(goalsDir(root), goalId);
export const treePath = (root, goalId) => path.join(goalDir(root, goalId), 'derived', 'tree.json');
export const statePath = (root, goalId) => path.join(goalDir(root, goalId), 'derived', 'state.json');
export const eventsPath = (root, goalId) => path.join(goalDir(root, goalId), 'events.jsonl');
// ... etc

export function activeGoalId(root): string | null
export function setActiveGoalId(root, goalId): void
```

All callers of `treePath(root)` must update to `treePath(root, goalId)`. A new helper `withActiveGoal(root, fn)` reads `.active`, fails fast if missing, and invokes `fn(goalId)` — used by the Stop hook and most CLI scripts.

### New commands

Six new commands, all thin wrappers around engine helpers:

| Command | Action |
|---|---|
| `/goal-list` | List every goal in `.claude/goals/`. Show id, lifecycle, cursor (if applicable), last-event-ts. The active goal is marked with `▶`. |
| `/goal-switch <id>` | Set `.active` to `<id>`. Refuses if `<id>` is in a terminal lifecycle. |
| `/goal-fork <id> [--as <new-id>]` | Copy the events.jsonl of goal `<id>` up to its most recent `lifecycle-changed → approved` event into a new goal namespace. Default new-id: `<id>-fork-<timestamp>`. New goal is in `draft` lifecycle until `/goal-approve-plan`. |
| `/goal-detail <id>` | Print full status report for `<id>` (same content as `/goal-status` but for a non-active goal). |
| `/goal-delete <id>` | Remove the goal directory entirely. Refuses if `<id>` is the active goal. Asks for confirmation. |
| `/goal-create <id>` | (Optional sugar) Initialize an empty goal directory with `<id>`. Sets `.active` to it. Equivalent to `/goal-plan` writing into the new namespace. |

### Existing commands

All existing commands accept an optional `--goal-id <id>` flag. When omitted, they target the active goal (read from `.active`). When supplied, they target the specified goal regardless of which is active.

### Stop hook

The Stop hook reads `.active` at start. If `.active` is missing or points to a non-existent / terminal goal, the hook exits 0 with no-op (no behavior). If it points to a live `pursuing` goal, it drives that goal — same flow as v1.x.

There is exactly one active goal at a time per project. Multiple goals can exist; only one is driven by the Stop hook. Users switch between them with `/goal-switch`.

## Consequences

### Positive

- **Real parallel goals.** User can have 5 goals coexisting; switching between them is one CLI call. Each retains its event log, snapshots, plan, notes, and audits.
- **Forking workflow.** Templating and derivative goals become first-class. `/goal-fork` provides a clean baseline.
- **Cross-goal visibility.** `/goal-list` shows everything; future cross-goal queries (token-budget remaining across all live goals, etc.) become tractable.
- **No data loss on switch.** v1.x's "clear to start a new goal" is replaced by "switch to a different goal namespace". Old goal's event log stays intact.
- **Cleaner archive model.** No mental distinction between "active" and "archived" goals — they're all just goals in different lifecycle states. The archive concept disappears (replaced by the `cleared` lifecycle and `/goal-delete` for outright removal).

### Negative

- **Breaking path API.** Every site in the codebase that uses `treePath(root)`, `statePath(root)`, `auditsDir(root)` etc. must add a `goal_id` argument. This is mechanical but touches dozens of files (8 CLI scripts, Stop hook, ~10 test files). Sed-style refactor with TS would catch this; in JS it's caught by the test suite.
- **Migration risk for live v1.x goals.** Existing `.claude/goals/active/` becomes `.claude/goals/<id>/` where `<id>` is read from `tree.json::goal_id`. Migration script must do this atomically. Existing archive/<date>-<slug>/ entries get migrated to top-level `<slug>/` with their tree.json's goal_id (deduped if collisions).
- **More files in `.claude/goals/`.** A user with 20 goals over time has 20 subdirectories. Default behavior is fine; `/goal-list` provides discoverability.
- **Active-pointer corruption.** If `.active` becomes corrupt (manual edit, partial write), Stop hook bails safely (exits 0) but user sees no progress. Mitigation: `.active` is a single short string (the goal_id), trivial to inspect and fix; `/goal-status` prints helpful error if `.active` malformed.

## Alternatives considered

| Alternative | Rejected because |
|---|---|
| **Keep `active/` as canonical, add a `goals/<id>` mirror after termination** | Doesn't enable parallel live goals. Same as v1.x with renamed archive. |
| **Symlink `active/` → `<id>/`** | Symlinks are portable but Windows-fragile (and Claude Code is used on Windows). A `.active` text file is universally portable. |
| **Multiple `active/` subdirs (`active-a/`, `active-b/`)** | Encodes ordering ("a" before "b") into the filesystem; no clean way to rename without breaking references. |
| **Goal IDs as integers** | Conflict with user-meaningful names; less readable in event logs and on disk. Slugs are better. |
| **Single events.jsonl across all goals with `goal_id` field on every event** | Cross-goal isolation suffers (lock contention, event-log size for one goal blocks reducer for another). Per-goal events.jsonl is cleaner. |

## Migration

The migration must handle both `.claude/goals/active/` (v1's live goal) and `.claude/goals/archive/<date>-<slug>/` (v1's archived goals).

### Phase A — Compatibility shim (`v1.x+2`)

1. Add `engine/paths.mjs` overloads: every `treePath(root)` etc. is now `treePath(root, goalId?)`. When called with one arg, the helper reads `.active` and substitutes that (or falls back to `'active'` for v1 compatibility). This means existing v1.x callers still work unchanged.
2. Add `engine/paths.mjs` legacy alias: `activeDir(root)` returns the old `.claude/goals/active/` for v1 compatibility.
3. Update all engine code to pass `goal_id` explicitly. Default-fallback paths warn to stderr "deprecated: paths.X called without goal_id".
4. Ship as a v1.x minor.

### Phase B — Migration script (`v2.0.0-rc`)

1. New CLI: `node engine/migrate-v1-to-v2-layout.mjs`. Idempotent. Behavior:
   - For `.claude/goals/active/`: read tree.json::goal_id; create `.claude/goals/<goal_id>/`; move all files. Write `.active = <goal_id>`.
   - For each `.claude/goals/archive/<date>-<slug>/`: read tree.json::goal_id; if collision with active, prefix `<goal_id>-archive-<date>`; create `.claude/goals/<final-id>/`; move all files.
   - Remove the now-empty `archive/` directory.
2. Tests: migration script handles empty project, single-active, single-archive, multi-archive, name collision, partial migration (re-run after crash).
3. CHANGELOG: instructions for users to run the migration as a one-time step.

### Phase C — Cleanup (`v2.0.0`)

1. Remove paths.mjs compatibility shims. All callers must pass `goal_id` explicitly.
2. Remove `archive/` references from docs.
3. Remove `clear --archive` flag (archiving is no longer a separate concept).

## Open questions

- **Q1.** Goal ID character set. Proposed: `[a-z0-9-]{2,64}` (slug-style, no underscores, no uppercase). Strict to avoid filesystem surprises across Windows/macOS/Linux. Revisit if too restrictive for real users.
- **Q2.** Should `.active` be a symlink or a text file? Text file (already decided in Decision). Symlinks complicate Windows + Claude Code's plugin install paths.
- **Q3.** `/goal-list` output format. Default: human-readable table to stdout. Add `--json` flag for scripts. Defer specific schema until plan-D3 phase 0.
- **Q4.** Should `/goal-delete` move to a `.trash/` subdir for recovery? Initial decision: hard delete with confirmation. Trash adds complexity; recovery is via the user's own backup discipline.
- **Q5.** Cross-project `/goal-list`? Out of scope for v2.0.0 — would require a `~/.claude/goal-mode/registry.json` of known projects. Deferred.

## References

- ADR 0001 (event log) — pre-requisite, this ADR's per-goal events.jsonl is downstream of that
- ADR 0002 (locking) — pre-requisite, this ADR's per-goal `.lock` is downstream of that
- `engine/paths.mjs` — primary refactor target
- `engine/stop-hook.mjs` — must read `.active` at start
- v1.x `.claude/goals/active/` and `.claude/goals/archive/` — what we're migrating away from
