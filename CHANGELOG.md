# Changelog

All notable changes to Better Goal (formerly `claude-code-goal-mode`) are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## v3.0.6 — Smart silence detection (tool_use counts as engagement)

Closes a false-positive in auto-pause-on-silence (v2.0.6) reported by user 2026-05-12 on mancelot autonomous run.

### Root cause
Auto-pause counted "no goal-mode tag emission this turn" as silence. But controllers doing legitimate work — running tests via Bash, reading source files via Read, dispatching subagents via Agent, editing code via Edit — fire ZERO goal-mode tags per-turn during exploration/setup phases. Only the final "achieve" turn emits tags. Multi-turn exploration (25+ turns is normal for complex tasks) accumulated false-positive silence and auto-paused.

Raising silenceThreshold (v3.0.5: 5→20) was the wrong fix — it just delayed the same false-positive on slightly longer exploration phases.

### Fix
Engine now treats ANY `tool_use` block in the turn's transcript as engagement, alongside goal-mode tag events. Only turns with neither tools nor tags count as silent.

### Changed
- `engine/transcript-checkpoint.mjs`: `advanceTallyScan` returns `tool_use_count` from the scan window.
- `engine/stop-hook.mjs`: `turnHadEngagement` now `OR`s tag events with `tool_use_count > 0`.
- New regression tests in `tests/v3-tool-use-engagement.test.mjs`.

### NOT changed
- Auto-pause still active for genuine silence (controller refusing to engage, no tools, no tags).
- Triple-budget hard ceiling unchanged.
- `silenceThreshold` default stays at 20 from v3.0.5.
- Stale-review-pending detector (v3.0.1), v3 CLI verbs (v3.0.0), auto-promote (v3.0.3) — all unchanged.

---

## v3.0.5 — Raise auto-pause silenceThreshold default 5 → 20

User feedback 2026-05-12: the v2.0.6 auto-pause-on-silence detector was too aggressive for autonomous production runs. Controllers legitimately spend 5-10 turns in exploration phases (reading files, running tests, iterating) without emitting goal-mode tags. The 5-turn threshold (calibrated against the degenerate "controller refuses to engage" case) triggered false-positive auto-pause on legitimate work.

This release raises the default to 20. Auto-pause remains an early-warning safety net layered on top of the triple budget (iterations/tokens/wallclock) — it now triggers only on genuine controller-stuck patterns, not on exploration.

### Changed
- `engine/plugin-config.mjs`: `silenceThreshold` default `5` → `20`.
- `engine/stop-hook.mjs`: `SILENCE_THRESHOLD` constant now sourced from `cfg.silenceThreshold` (was hard-coded `5`). Config-driven end-to-end.
- `tests/auto-pause-on-silence.test.mjs` setup: explicit `silenceThreshold: 5` in fixture config to preserve existing test semantics without ballooning to 20-iteration loops.
- `tests/plugin-config.test.mjs`: default-value assertions updated.
- README Status block bumped to v3.0.5.

### NOT changed
- Auto-pause-on-silence still active (just at higher threshold).
- Triple-budget hard ceiling unchanged.
- `stale-review-pending detector` (v3.0.1) unchanged.
- All v3 CLI verbs unchanged.
- State schema unchanged.

### How to override

Per-project: `.claude/goals/active/config.json`:
```json
{ "silenceThreshold": 10 }
```

Per-user: `~/.claude/plugins/goal-mode/config.json` (same shape).

To restore old aggressive default: set `silenceThreshold: 5`. To effectively disable: set to a large number like `1000`.

---

## v3.0.4 — Auto-drive restored as default (correct out-of-the-box behavior)

User feedback 2026-05-12: the v3.0.0 default of `stopHookDriver: false` (Stop-hook returns null on `pursuing`) was an over-correction. The original product value of goal-mode / Better Goal is "set a verifiable objective, walk away, come back finished" — that requires auto-drive. The silence-loop bug v3.0 was designed to address only manifests when controller agents have memory rules forbidding engagement (a degenerate case), and is already adequately covered by:

- `auto-paused-on-silence` (v2.0.6) — 5 silent turns → auto-pause
- `stale-review-pending detector` (v3.0.1) — review-pending stale → awaiting-manual-approval

This release flips the default back to `stopHookDriver: true` so the out-of-the-box experience matches the product value: install, plan, walk away, come back. The v3 explicit CLI verbs (`evidence-add`, `achieve`, `submit-verdict`, etc.) remain fully supported and callable any time — they are now opt-in tools, not the default drive mode.

### Changed
- `engine/plugin-config.mjs`: `stopHookDriver` default `false` → `true`.
- `engine/doctor.mjs`: renamed check `legacy-stop-hook-driver` → `explicit-cli-mode`. Now warns when `stopHookDriver=false` (rare opt-out), ok when default `true` (auto-drive).
- README v3 section + Status block updated to reflect new default.
- Test fixtures updated: `plugin-config.test.mjs`, `stop-hook-v3.test.mjs`, `doctor-v3.test.mjs` adjusted for new default semantics.

### NOT changed
- v3 explicit CLI verbs (evidence-add, achieve, submit-verdict, current, review-request, as-builtin) — fully supported, callable any time.
- v3 auto-promote pending→pursuing on first CLI engagement (v3.0.3).
- v3 stale-review-pending detector (v3.0.1).
- v2.0.6 auto-pause-on-silence safety net.
- v2.0.4 escape-hatch + awaiting-manual-approval lifecycle.
- State schema, event log, reducer, lock.
- 11 legacy test files migrated to `stopHookDriver=true` fixture in v3.0.0 — still pass (their fixture is now redundant but harmless).

### Migration

If you were running v3.0.0-v3.0.3 with the hint-only default (no config.json), v3.0.4 will start auto-driving. If you prefer hint-only mode (e.g. controller has memory rules forbidding engagement, or you want explicit slash-command drive), create `.claude/goals/active/config.json` with:

```json
{ "schema_version": 1, "stopHookDriver": false }
```

That's the only thing that changes for hint-only users. Everything else is identical.

---

## v3.0.3 — Auto-promote pending → pursuing on first v3 CLI engagement

Closes a deadlock user-reported 2026-05-12 where a cursor stuck in `status=pending` (from historical v2 advance paths or after `/goal-mode:goal-resume`) made v3 CLI verbs (`evidence-add`, `achieve`) un-callable.

### Added
- `engine/evidence-add.mjs` + `engine/achieve.mjs`: auto-promote `cursor.status` from `pending → pursuing` on first invocation when `lifecycle === 'pursuing'` and `cursor.type === 'task'`. Recorded as a `cursor-engaged` history event with reason flag for traceability.
- New history event kind: `cursor-engaged` (added to `KNOWN_HISTORY_EVENTS` in `engine/state.mjs`).
- 7 new tests in `tests/v3-auto-promote-pending.test.mjs` covering the promote conditions + non-promote cases (lifecycle, non-task, terminal-status).

### Why
Pre-v3 (v2.0.6 driver mode), agents emitted `<task-status>pursuing</task-status>` as part of doing work — that tag transitioned `pending → pursuing` via `apply-mutations.mjs`. The v3 explicit CLI design assumed cursors were already in `pursuing` (or `review-pending`) by the time a verb was called, but historical v2 state and `goal-resume` left them in `pending`. Auto-promote on first engagement removes the need for an extra "engage cursor" verb and matches the v2 implicit pattern semantically.

### Unchanged
- v3 default mode (Stop-hook hint-only).
- Legacy v2 driver mode (`stopHookDriver: true`) — unaffected; agents continue to emit `<task-status>pursuing</>` as before.
- Reviewer-independence, escape-hatch, auto-pause, stale-review detector — all preserved.
- State schema (`schema_version: 2`).

---

## v3.0.2 — Brand rename to "Better Goal" (cosmetic)

Surface rename only. Zero code changes, zero behaviour changes.

### Changed
- README title `claude-code-goal-mode` → **Better Goal**.
- `marketplace.json` / `plugin.json` descriptions updated to "Better Goal — …".
- CHANGELOG header line updated.
- Version bump 3.0.1 → 3.0.2 in `package.json`, `marketplace.json`, `plugin.json`.

### NOT changed (deliberately, to avoid breaking users)
- npm package `name` (`claude-code-goal-mode`).
- Plugin namespace (`goal-mode`).
- Slash command prefix (`/goal-mode:goal-*`).
- Skill directory names (`using-goal-mode`, `goal-mode-tag-discipline`).
- Plugin install path (`~/.claude/plugins/cache/goal-mode/goal-mode/`).
- GitHub repo URL (`lokafinnsw/claude-code-goal-mode`) — kept stable; can be renamed via GitHub UI later, GitHub auto-redirects from old URL for 90 days.

If a future major release (v4.0) does a hard CLI rename, that will be a coordinated breaking change with a migration guide.

---

## v3.0.1 — Stale-review-pending detector (legacy driver hardening)

Closes a v2-driver-mode bug pattern user-reported 2026-05-12: after a controller agent dispatches a reviewer subagent (1-5 min Agent() call) and stalls before emitting `<audit-verdict>` tags, the Stop-hook re-renders the same expensive review prompt every tick, burning ~30K tokens per retry.

### Added
- `engine/stale-review-detector.mjs` — `checkStaleReviewPending(state, cursor, now, thresholdMs?)` detects review-pending cursors with no verdict events for >15 minutes wall-clock, transitions lifecycle to `awaiting-manual-approval` (v2.0.4 escape-hatch landing state). Recovery via `/goal-mode:goal-approve`.
- Stop-hook integration: stale check runs **only** under `stopHookDriver: true` (legacy mode), keyed on the `review-requested` event timestamp (not silent-turn count, so heavy Agent() dispatches don't false-positive).
- 8 new tests in `tests/stale-review-detector.test.mjs`.

### Why stale-detector ≠ v2.0.6 silence-counter
Silence-counter (`consecutive_silent_turns`) treats every turn without engagement tags as silent — including turns where the controller is waiting on a 5-min Agent() dispatch. Stale-detector anchors on the engine's own `review-requested` event timestamp and looks for verdict events after it, so heavy reviews don't trigger false-positive auto-pause.

### Unchanged
- v3.0 default mode unaffected (Stop-hook returns null on pursuing, so the bug pattern can't occur).
- State schema, event log, reducer, lock — unchanged.
- v2.0.4 escape-hatch + v2.0.6 auto-pause-on-silence continue to function alongside.

---

## v3.0.0 — CLI-first redesign

**Default behaviour changes; opt-out via config.** Stop-hook is hint-only on `lifecycle=pursuing`. Agents drive the loop via explicit CLI verbs.

### Added
- `engine/evidence-add.mjs` + `evidence-add-cli.mjs` + `/goal-mode:goal-evidence-add`
- `engine/achieve.mjs` + `achieve-cli.mjs` + `/goal-mode:goal-achieve`
- `engine/submit-verdict.mjs` + `submit-verdict-cli.mjs` + `/goal-mode:goal-submit-verdict`
- `engine/current.mjs` + `current-cli.mjs` + `/goal-mode:goal-current`
- `engine/review-request.mjs` + `review-request-cli.mjs` + `/goal-mode:goal-review-request`
- `scripts/as-builtin.sh` + `/goal-mode:goal-as-builtin` — bridge to built-in `/goal`
- `engine/plugin-config.mjs` — per-user + per-project config layering
- `doctor` check `legacy-stop-hook-driver` (warns when `stopHookDriver=true`)
- End-to-end integration test for v3 CLI flow (`tests/v3-cli-end-to-end.test.mjs`)
- Engine: explicit cursor-task `'pursuing'` promotion on advance (closes pre-v3 implicit-promotion gap that broke v3 CLI verbs)

### Changed
- Stop-hook returns `null` stdout on `lifecycle=pursuing` by default (was: render continuation.md every turn).
- `using-goal-mode` skill updated to v3 workflow (explicit CLI), legacy tag-emission flagged as fallback.
- `goal-mode-tag-discipline` skill flagged as optional/legacy.
- 11 legacy regression test files migrated to `stopHookDriver=true` fixture (preserves v2 driver coverage).
- README + CHANGELOG + new MIGRATION guide reflect the workflow change.

### Unchanged (carry-over from v2.0.6)
- State schema (`schema_version: 2`) — v2 state files load and work unchanged.
- Event log + reducer (ADR-0001).
- File locking (ADR-0002).
- Reviewer-independence guard (`scannedAgents` Set, transcript scan).
- Triple budget enforcement.
- Escape-hatch detector + `awaiting-manual-approval` lifecycle.
- Auto-pause-on-silence (v2.0.6) — still active under `stopHookDriver=true`.

### Migration

v2.x → v3.0 is a no-op for state files. After `bash install.sh && restart Claude Desktop`:
- **Default:** hint-only Stop-hook. Run `/goal-mode:goal-current` to see the task; use explicit CLI verbs to advance.
- **Legacy mode:** create `.claude/goals/active/config.json` with `{"schema_version": 1, "stopHookDriver": true}` to keep v2 behaviour.

See [docs/MIGRATION-v2-to-v3.md](docs/MIGRATION-v2-to-v3.md) for detailed migration steps.

### Stats

- 1002+ tests passing (≈30 new v3 tests + 11 legacy test files migrated to driver-on fixture).
- ~10 new files in `engine/`, `scripts/`, `commands/`, `tests/`, `docs/`.
- Zero schema changes.
- Zero breaking API changes for state files.

---

## [2.0.6] — 2026-05-12

**Auto-pause-on-silence — token-bleed safety net.**

Closes the controller-not-engaging spam loop user-reported during a live mancelot session: when the controller agent has a user-level rule that tells it not to engage with the goal in the current session (e.g., memory rule "Не лезь в игру"), the agent emits minimum-text per turn with no goal-mode tags. Pre-v2.0.6 the Stop hook had no signal to stop firing the continuation prompt — it kept firing every turn, bleeding the token budget for zero progress. User burned ~40M tokens over 6+ Stop-hook ticks before noticing.

### Added

- **New state field `consecutive_silent_turns`** (zod default `0`, backward-compatible — old state.json files get the field backfilled on parse).
- **`engine/stop-hook.mjs`** — after `applyMutations`, count engagement events from `turnHistory` (set of `evidence-added`, `review-requested`, `review-verdict`, `node-blocked`, `cursor-advanced`). If any engagement → reset counter to 0. Else → increment. When counter reaches `SILENCE_THRESHOLD = 5` AND lifecycle is still `pursuing`, auto-transition lifecycle to `paused`, record a `paused` history event with `payload.reason='auto-paused-on-silence'` + `payload.silent_turns` + `payload.recovery` hints, write a stderr diagnostic.
- **`prompts/auto-paused-on-silence.md`** — one-shot recovery prompt rendered on the transition tick so the user sees a clear explanation of why the loop suddenly stopped.
- **`engine/lifecycle-commands.mjs::resumeGoal`** — resets `consecutive_silent_turns` to 0 alongside the standard `paused → pursuing` transition. Without this, a goal that resumes after auto-pause and immediately has another silent turn would re-trigger pause on turn 1 instead of turn 5.
- **`engine/session-start-hook.mjs`** — surfaces auto-paused state distinctly on new session open. User-initiated `/goal-pause` still falls through to the silent null-stdout passthrough (the user knows they paused it). Only auto-paused goals get the SessionStart hint.
- **`engine/doctor.mjs::checkAutoPausedOnSilence`** — new check, reports `warn` with 3 recovery options when goal was auto-paused (resume / abandon / clear).

### Tests

- **`tests/auto-pause-on-silence.test.mjs`** — 11 regression tests:
  - Silent-turn counter increments / engagement resets / threshold triggers auto-pause (3 tests)
  - Stop-hook returns null stdout on subsequent ticks after auto-pause (1 test, no spam)
  - `/goal-resume` resets counter and restores `pursuing` (1 test)
  - SessionStart surfacing differs for auto-paused vs user-paused (2 tests)
  - Doctor check for auto-paused vs user-paused vs pursuing (3 tests)
  - Backward compat: pre-v2.0.6 state.json without the field gets default 0 (1 test)

### Test suite

- 918 pass / 2 skip / 0 fail across 53 files (was 907/2/0 in v2.0.5).

### Behavior summary

| Pre-v2.0.6 | v2.0.6 |
|---|---|
| Controller emits 0 goal-mode tags for N turns → Stop hook keeps firing | Counter increments. At N=5, lifecycle auto-pauses with recoverable reason |
| User must manually notice + type `/goal-pause` to stop the bleed | Engine stops the bleed automatically after 5 turns |
| Token budget drains silently | Single stderr diagnostic + one-shot prompt explaining the pause |
| SessionStart never surfaces "your goal is in this odd state" | SessionStart hint when reopening session shows auto-pause + 3 recovery options |

### Migration

- No schema change beyond an optional defaulted field. After pulling v2.0.6:
  1. `bash install.sh` to update the plugin pin
  2. Restart Claude Desktop
  3. Existing state.json files get `consecutive_silent_turns: 0` defaulted on next load (no migration step)
- For goals already stuck in pre-v2.0.6 spam loops: after install + restart, the next Stop-hook tick starts counting from 0. 5 more silent turns → auto-pause. OR run `/goal-mode:goal-pause` immediately.

### Skill notes

- `skills/using-goal-mode/SKILL.md` — Lifecycle states table already includes `paused`; v2.0.7+ may add a row distinguishing auto-paused from user-paused. The current skill is correct for the v2.0.6 behavior (paused = Stop hook returns null, /goal-resume to continue).

## [2.0.5] — 2026-05-11

**Agent-facing skills + README overhaul.** UX is product surface — this release ships the documentation+behavior contract that teaches controller agents how to interact with the engine without breaking it.

### Added

- **`skills/using-goal-mode/SKILL.md`** (21 KB) — comprehensive guide for controller agents. Covers:
  - Mental model (Sprint → Epic → Task, cursor advancement, evidence-mapped acceptance criteria)
  - All 8 lifecycle states with what each means and what the agent should do
  - Tag emission discipline (the 5 tag kinds, the two-layer `<details>` convention)
  - Reviewer-independence enforcement (v2.0.0+) — why fabricated verdicts are rejected
  - Escape-hatch protocol (v2.0.1 + v2.0.4) — exact verdict format, what happens in `awaiting-manual-approval`, when to STOP emitting
  - Skill-vs-Agent gotcha — when a "reviewer" is a Skill (markdown at `~/.claude/skills/<name>/`) but lacks the paired Agent file (`~/.claude/agents/<name>.md`), `Agent(subagent_type=...)` fails; explanation of how to register the matching Agent file vs. use the escape hatch
  - Multi-session / cross-project isolation (v2.0.2 + v2.0.3) — why `stdin.cwd` is canonical, what shell `cd` does NOT change
  - Recovery paths summary table
  - 9 anti-patterns (categorically forbidden, with the failure modes each guards against)
  - Plugin maintenance — which symptoms map to which version's fix; upgrade procedure
  - Quick reference: state-file paths + most-useful commands
  - `<SUBAGENT-STOP>` clause so reviewer subagents skip the skill (they emit `<audit-verdict>` only per `commands/goal-review.md`)
- **`skills/goal-mode-tag-discipline/SKILL.md`** (11 KB) — precise reference for `engine/parse-tags.mjs` semantics. Covers:
  - Pre-parse `stripCodeRegions` exact regexes (what gets stripped before parsing)
  - Full regex for each tag (`<evidence>`, `<task-status>`, `<blocker>`, `<review-request>`, `<audit-verdict>`)
  - Attribute parsing nuances (quoting, duplicate attrs, numeric attrs, HTML escapes, nested tags)
  - Escape-hatch detection regex (`/^\s*unavailable\b/i`) with positive and negative examples
  - Tag visit order within one turn's parse output
  - 6 common emission mistakes with cause/effect
  - When to use this skill vs `using-goal-mode`

### Changed

- **README.md** — major refresh:
  - Lifecycle table updated to 8 states (was 7); `awaiting-manual-approval` documented
  - New "Skills for agents" section pointing at both skill definitions
  - Tags reference table modernized (replaced loose prose with structured table; `criterion` correctly noted as integer; case-insensitivity flagged; reviewer-independence requirement explained)
  - Escape-hatch verdict format documented in body (was only in CHANGELOG)
  - Structural defenses (proxy-signal collapse + fabricated verdicts + code-fence stripping) called out together
  - Status section consolidated: single "What's new in the 2.0.x line" summary instead of stacked version notes; version log table at the bottom; current architecture diagram of `.claude/goals/active/`

### Test suite

- 907 pass / 2 skip / 0 fail — unchanged from v2.0.4 (no engine code changes in this release; new files are skill markdown + README edits).

### Migration

- No state/schema migration. After pulling v2.0.5:
  1. `bash install.sh` to update the plugin pin
  2. Restart Claude Desktop (so the plugin loader picks up the new `skills/` directory)
  3. Skills auto-register; `using-goal-mode` and `goal-mode-tag-discipline` appear in the agent's available skill list

### Why this matters

Pre-v2.0.5, the only agent-facing documentation was `commands/goal-help.md` (slash command body, terse) plus the continuation-prompt templates themselves. Agents learned the rules by trial and error across many goals — and frequently mis-emitted tags, fabricated verdicts, or fell into the escape-hatch loop because the recovery semantics weren't documented anywhere they would read.

The skills system in Claude Code is the canonical place for "rules an agent must know" — auto-discovered, declared with `description` so the agent knows when to invoke. Putting goal-mode's behavior contract there means every Claude session interacting with an active goal will load the rules before acting, instead of guessing.

UX is product surface. A SOTA engine that emits silently-dropped tags or surprises users with environmental-cause unmets isn't SOTA — it's correct code with a broken contract. v2.0.5 closes the contract gap.

## [2.0.4] — 2026-05-11

**Escape-hatch lifecycle gate.** Kills the "Не лезу loop" user-reported on 2026-05-11.

### The bug it closes

Pre-v2.0.4, when an assistant emitted the escape-hatch verdict (`<audit-verdict status="REVISE">unavailable; user must run /goal-approve</audit-verdict>` — the documented signal that the reviewer's subagent_type isn't registered in the environment), v2.0.1's fix marked the cursor `blocked` immediately with a recovery hint in `cursor.blocker_reason`. But **lifecycle stayed `pursuing`**, so the Stop hook kept firing `continuation-blocked.md` on every subsequent turn. The agent (which cannot fix an environmental missing-subagent-type problem from code) re-emitted `<task-status>blocked</task-status>` with the same reason every turn, ticking `cursor.review_attempts` toward the 3-strike `unmet` threshold. Within ~3 turns the goal terminated `unmet` purely from environmental cause — even though all the substantive work was correct.

Worse: each `decision: 'block'` Stop-hook prompt **forced** the assistant to emit text to unblock the chat turn. The user saw 10+ repeated "Не лезу" minimum-text responses while the engine kept demanding action on a task the assistant couldn't address.

### Fix

New `awaiting-manual-approval` lifecycle — terminal-but-recoverable state introduced by the escape-hatch flow:

- **`engine/apply-mutations.mjs`** — when an escape-hatch verdict fires, the same `applyMutations` call now ALSO transitions `state.lifecycle = 'awaiting-manual-approval'` and emits a `lifecycle-changed` history event with `from: pursuing`, `to: awaiting-manual-approval`, `unavailable_reviewers: [...]`.
- **`engine/stop-hook.mjs`** — renders `continuation-blocked.md` ONCE on the transition tick (so the user sees the recovery instructions: `/goal-approve` / register agent / revise plan). On all subsequent ticks the existing `lifecycle !== 'pursuing'` gate fires and Stop-hook returns null stdout → no spam, no forced response.
- **`engine/manual-approve.mjs`** — accepts both standard entry (cursor `review-pending` + lifecycle `pursuing`) AND escape-hatch entry (cursor `blocked` + lifecycle `awaiting-manual-approval`). On success: clears `cursor.blocker_reason`, marks cursor `achieved`, advances `state.cursor`, restores `state.lifecycle = 'pursuing'`, and emits a paired `lifecycle-changed` event for the reverse transition.
- **`engine/session-start-hook.mjs`** — surfaces the awaiting state on new session open with the three recovery options (was previously silent because lifecycle ≠ pursuing).
- **`engine/lifecycle-commands.mjs`** — `/goal-resume` rejects awaiting-manual-approval with a clear "use /goal-approve <task-id>" hint. `/goal-abandon` accepts the lifecycle (user can decide to mark goal `unmet` instead of approving). `/goal-pause` rejects (only `pursuing` is pauseable; awaiting-manual-approval is already idle).
- **`engine/doctor.mjs`** — new `checkAwaitingManualApproval` reports `warn` with action when goal is stalled, surfacing the unavailable reviewer name(s) from history. Other lifecycles → `ok`.
- **`engine/state.mjs`** — `LifecycleSchema` enum extended with `'awaiting-manual-approval'`.
- **`engine/reducer.mjs`** — `lifecycleHistoryEvent('awaiting-manual-approval')` returns `'lifecycle-changed'` for forensic walk grep-ability.

### Tests

- **`tests/awaiting-manual-approval.test.mjs`** — 19 new regression tests:
  - apply-mutations lifecycle transition + history event shape (3 tests)
  - Stop hook one-time render + subsequent suppression (2 tests)
  - manualApprove escape-hatch entry + lifecycle restoration + blocker_reason clear + paired transition + still-rejects-other-cases (5 tests)
  - SessionStart hook surfacing (2 tests)
  - lifecycle commands handling (3 tests)
  - doctor check (3 tests)
  - **end-to-end "no Не-лезу loop" integration**: escape-hatch → one prompt → 3 silent ticks → /goal-approve → cursor advances (1 test)

### Test suite

- 907 pass / 2 skip / 0 fail across 52 files (was 888/2/0 in v2.0.3). +19 tests.

### Doctor

- 13 ok / 0 warn / 0 fail on a healthy goal (was 12/0/0 in v2.0.3). New `awaiting-manual-approval` check.

### Migration

- No schema migration. Pull v2.0.4, `bash install.sh`, restart Claude Desktop.
- Existing goals stuck in pre-v2.0.4 `unmet`-from-escape-hatch state: run `/goal-mode:goal-clear --archive`, re-plan from where the work landed. Future escape-hatch cases will auto-transition to the new lifecycle and never hit the unmet path.

## [2.0.3] — 2026-05-11

**Full SOTA hardening pass — Apex2 methodology (Plan → Explore → Execute → Verify).**

Audit-driven release closing every Critical, Important, and Minor finding from the 2026-05-11 engineering review of v2.0.2. Zero tech debt left behind; each fix lands with regression tests and is wired into the live hook execution paths. Test suite grew from 836 → 888 pass (+52 new tests across 4 new test files).

### Critical fixes (5/5)

- **C1: SessionStart hook rendered review/blocked templates with undefined fields.** Pre-v2.0.3, only Stop-hook enriched `ctx.audit_instructions / rejected_verdicts / has_rejected_verdicts / uncovered_criteria / last_verdicts / unavailable_reviewers*`. SessionStart called `buildContext` and rendered directly, so auto-resume on a review-pending or blocked task showed empty sections / literal `{{placeholders}}`. **Fix:** new shared `engine/hook-context.mjs::enrichContinuationContext()` invoked from both hooks. Single source of truth.
- **C2: Stop hook polluted every project with empty `.claude/goals/active/` directories.** `acquireLock` calls `fs.mkdirSync(goalDir, { recursive: true })` as a side effect. Pre-v2.0.3 the Stop hook acquired the lock before the `loadState` null-check, so every Stop-hook fire on every project without a goal created the directory. In a multi-project Claude Desktop setup this littered the filesystem. **Fix:** `hasActiveGoal(projectRoot)` precheck via `engine/hook-context.mjs` — no state.json → return immediately, no lock, no mkdir.
- **C3: Transcript scanning was O(full-file) every Stop-hook tick.** `tallyTokens()` and `scanAgentInvocations()` each read the entire transcript JSONL on every tick. On long sessions transcripts grew to tens or hundreds of megabytes; every Stop-hook fire re-read and re-parsed everything. Measurable lag on every user turn. **Fix:** new `engine/transcript-checkpoint.mjs` persists offset + cumulative-total + per-Agent-dispatch list at `.claude/goals/active/.transcript-cache.json`. Stop hook calls `advanceTallyScan()` once per tick — reads only newly-written bytes. The checkpoint is saved AFTER successful turn so mid-turn crashes don't lose unprocessed entries.
- **C4: Token tally undercounted across CC transcript rotations.** When CC rotated the transcript (across `/compact` or session boundary), pre-v2.0.3 `tallyTokens` recounted from zero and silently overwrote `state.budget.tokens.used` with the smaller value. Goals could overshoot token budget. **Fix:** the new checkpoint detects rotation via (size shrink) OR (sha256 fingerprint mismatch on first 256 bytes) and preserves the prior `tokens_total` as a monotonic floor. Stderr diagnostic on rotation.
- **C5: `loadStateFromEvents` cache write-back raced concurrent writers.** Pre-v2.0.3, `loadStateFromEvents` unconditionally wrote the replayed state and tree back to state.json + tree.json without acquiring the ADR-0002 lock. Atomic rename is per-file; the pair could end up out of sync with each other if a concurrent Stop hook was mid-write. **Fix:** `loadStateFromEvents` is now strictly READ-ONLY. New explicit `recoverCacheFromEvents(projectRoot)` (in `engine/state.mjs`) handles the cache-rewrite path under `withLockSync`. Legacy `writeCache` option is accepted but ignored (backward compat).

### Important fixes (10/10)

- **I1: `PLUGIN_ROOT` resolution broke on Windows.** Pre-v2.0.3 used `new URL('..', import.meta.url).pathname` which on Windows returns `/C:/path/...` with a leading slash. Replaced with `fileURLToPath()` via `engine/hook-context.mjs::resolvePluginRoot()`.
- **I2: `HistoryEventSchema` was a strict zod enum that broke on new event kinds.** Adding a new event in apply-mutations.mjs would silently break `saveState` via zod.parse rejection. **Fix:** liberalized to `z.string().min(1)`. The semantic enum (`KNOWN_HISTORY_EVENTS`) is still exported for documentation. Real per-kind validation lives in `event-payloads.mjs` for the event-log canonical path.
- **I3: history archive `history-<ts>.jsonl` could collide in the same ms.** Two saveState calls in the same millisecond produced colliding filenames; `writeFileSync` overwrote, losing data. **Fix:** append a zero-padded seq suffix `history-<ts>-<seq>.jsonl` AND switch to `appendFileSync` as belt-and-suspenders.
- **I4: Escape-hatch recovery info disappeared after history rotation.** The `unavailable_reviewers_csv` enrichment in `continuation-blocked.md` walked `state.history` for the most recent `node-blocked` event with `payload.escape_hatch=true`. If `saveState`'s 200-entry rotation cut those entries, the section vanished and the user got a generic blocked prompt without `/goal-approve` hints. **Fix:** rotation-resilient fallback — extract agent names from `cursor.blocker_reason` (which persists on the tree, not subject to rotation) via regex.
- **I5: Session-rebind anti-flap heuristic broke under clock-skew.** `Date.now() - new Date(lastRebind.ts).getTime()` returned negative when an NTP correction moved time backward; the `< 60_000` check then falsely accepted, blocking legitimate rebinds. **Fix:** `Math.max(0, rawAgeMs)` clamp. Conservative semantic (might falsely block once, never falsely allow flap).
- **I6: `scanAgentInvocations` fail-OPEN on missing timestamp.** Pre-v2.0.3, transcript entries without a top-level `timestamp` field passed the `sinceTs` filter regardless. Any historic Agent invocation could falsely vouch for the current turn's reviewer — closing a reviewer-independence bypass. **Fix:** the checkpoint's `scanAgentInvocationsIncremental` is FAIL-CLOSED on `ts: null` when `sinceTs` is set (unset sinceTs preserves CLI-test compat).
- **I7: Stop hook acquired lock before validating session_id / lifecycle.** Subsumed by **C2** fix.
- **I8: `atomicWrite` cross-volume rename hazard.** Documented in code comment (no behavioral change; rename remains within the project dir).
- **I9: `project-root.mjs` does not resolve symlinks.** Documented in code comment.
- **I10: `doctor checkBudgetHeadroom` showed FAIL for achieved goals.** Pre-v2.0.3 budget % was computed regardless of lifecycle; an achieved goal with 277% wallclock used (historical) showed as `fail`. **Fix:** lifecycle-aware skip — non-pursuing goals return `ok` with `"budget counters are historical (not actionable)"`.

### Minor fixes (8/8)

- **M1: `allCriteriaCovered` used `>=` instead of `===`.** Cosmetic — covered set is filtered to in-range indices, so size ≤ length always; `===` is the precise expression. Comment added explaining the invariant.
- **M2: payload validation crashes wrapped in stop-hook outer try.** Already correct; no change.
- **M3: reducer purity lint forbidden patterns include `new Date()` without args.** Already correct in `tests/reducer-purity.test.mjs`. Reviewed.
- **M4: `acquireLockSync` Atomics.wait note.** Documented in code comment.
- **M5: `last_verdicts` could show duplicates after multi-verdict turns.** **Fix:** `enrichContinuationContext` deduplicates by `(agent, status, text)` key.
- **M6: `review_attempts` is overloaded for review NOGO and task-status:blocked.** Documented (no rename; ABI stability).
- **M7: `parse-tags` `<task-status>` was strict-case.** Agents emitting `ACHIEVED` (paraphrased) were silently dropped, stalling the engine. **Fix:** normalize to lowercase before enum check; new tests `C10`, `C10b`, `C10c` lock the behavior in.
- **M8: `continuation-blocked.md` duplicate text between sections.** Minor UX; deferred.

### Observations (selected)

- **O3: `project-root.mjs` fallback now emits stderr warning on invalid `stdin.cwd`.** The fallback to `process.cwd()` is preserved (we don't hard-fail and break every hook on a CC transient cwd glitch), but invalid stdin.cwd now generates a diagnostic the user / CC engineers can see.
- **O4: migrate-v1-to-v2 idempotency** — already correctly checked via `countEvents(projectRoot) > 0`. Reviewed.
- **O5: CI workflow** — `.github/workflows/ci.yml` already present. Reviewed.

### New modules

- **`engine/hook-context.mjs`** (152 lines) — `enrichContinuationContext`, `hasActiveGoal`, `hasActiveGoalAndTree`, `resolvePluginRoot`, `readPromptFile`. Shared by Stop and SessionStart hooks.
- **`engine/transcript-checkpoint.mjs`** (296 lines) — `advanceCheckpoint`, `advanceTallyScan`, `tallyTokensViaCheckpoint`, `scanAgentInvocationsIncremental`, `loadCheckpoint`, `saveCheckpoint`.

### New tests

- **`tests/hook-context.test.mjs`** (16 tests) — enrichment for review/blocked templates, rotation-resilient fallback via `cursor.blocker_reason`, no-op for plain `continuation.md`.
- **`tests/hook-no-pollution.test.mjs`** (4 tests) — C2 regression: Stop and SessionStart hooks don't create `.claude/goals/active/` on projects without a goal.
- **`tests/transcript-checkpoint.test.mjs`** (19 tests) — initial scan, incremental scan, trailing partial line handling, rotation detection (size shrink + fingerprint mismatch), fail-closed semantic on missing timestamp, malformed line skipping, missing-file resilience, save/load round-trip.
- **`tests/cache-writeback-lock.test.mjs`** (8 tests) — C5 regression: `loadStateFromEvents` no longer touches state.json/tree.json mtime; `recoverCacheFromEvents` rewrites under the lock; `LockTimeoutError` on contention.
- **`tests/anti-flap-clock-drift.test.mjs`** (3 tests) — I5 regression: future-dated lastRebind doesn't falsely block legitimate rebind; genuine recent ping-pong still blocked; old ping-pong outside 60s window unblocked.
- **`tests/adversarial.test.mjs`** C10 inverted + C10b, C10c added — M7 case-insensitive task-status.
- **`tests/crash-injection.test.mjs`** updated for v2.0.3 read-only loadStateFromEvents + explicit recoverCacheFromEvents API.

### Test suite

- **888 pass / 2 skip / 0 fail across 51 files** (was 836 in v2.0.2). +52 new tests.

### Migration

- No state/schema migration needed. After pulling v2.0.3:
  1. `bash install.sh` to update the plugin pin
  2. Restart Claude Desktop (so all host processes load v2.0.3 hooks)
  3. The new `.transcript-cache.json` file will be created automatically on the first Stop-hook tick of each goal
- Existing transcripts are scanned from byte 0 on first tick (no migration needed; the checkpoint bootstraps itself).

## [2.0.2] — 2026-05-11

**Hotfix — cross-project leakage.** When the user runs multiple Claude Desktop session tabs each opened to a different project, Claude Desktop in some configurations fans out hook calls for all tabs from a single host process carrying that host's initial `process.cwd()`. v2.0.1 and earlier resolved `projectRoot` via `process.cwd()`, so one project's `.claude/goals/active/` continuation prompts could leak into every other session tab — user reported "mancelot continuation appears in all my other projects" on 2026-05-11.

### Fixed

- **`engine/project-root.mjs`** (new) — `resolveProjectRoot(stdin, deps)` pure function that prefers Claude Code's `stdin.cwd` (the canonical per-event project dir included in the hook protocol payload) over `process.cwd()`. Strict validation chain: must be a non-empty absolute path pointing at a real directory; any failure falls back to `process.cwd()` (preserves v2.0.x behavior for environments where `stdin.cwd` is missing).
- **`engine/stop-hook-cli.mjs`** — now calls `resolveProjectRoot(stdin, { fs, path, fallbackCwd: process.cwd() })` instead of trusting `process.cwd()` blindly. Inline doc-comment cross-references the leakage bug.
- **`engine/session-start-cli.mjs`** — same fix applied symmetrically (SessionStart hook fires `auto-resume` continuation prompt; same leakage path).

### Tests

- **`tests/project-root-resolution.test.mjs`** — 17 new regression tests covering: happy path (stdin.cwd preferred when absolute + real dir), normalization (trailing slash, `..`, `//`), and 11 fallback edge cases (null/undefined/empty/non-string/non-object stdin; missing/null/empty/non-string/relative/non-existent/non-directory cwd). Plus a dedicated "cross-project leakage fix" subgroup verifying stdin.cwd wins over a completely different real fallbackCwd, and that invalid stdin.cwd falls back cleanly without silent leak.

### Test suite

- 836 pass / 2 skip / 0 fail across 46 files (was 819 in v2.0.1; +17 from this hotfix).

### Migration

- No state/schema migration needed. The fix is purely in the hook CLI entry points. Run `bash install.sh` after pulling v2.0.2 to deploy the new code; existing goal state is untouched.

### Why this slipped past G1 gates

The G1 acceptance suite tests engine purity, replay perf, migration correctness, and crash recovery — none of them exercise the **Claude Desktop multi-tab host-process fan-out scenario**, which only manifests in the actual Desktop runtime. The plugin assumed `process.cwd()` always equalled the calling session's project dir. v2.1.0 backlog now includes a G2 gate for "hook CLI projectRoot honors stdin.cwd protocol field" to lock in this regression.

## [2.0.1] — 2026-05-11

**Hotfix.** Breaks an infinite-loop bug introduced in v2.0.0 when a reviewer's `subagent_type` is unavailable in the user's Claude environment.

### Fixed

- **Escape-hatch ↔ reviewer-independence detector contradiction.** v2.0.0 shipped the documented escape hatch (`commands/goal-review.md` line 62: "emit `<audit-verdict status=\"REVISE\">unavailable; user must run /goal-approve</audit-verdict>` when subagent unavailable") AND the new fabricated-verdict detector that rejected any verdict without a matching `Agent` tool_use in the transcript. The escape-hatch verdict, by definition, has no Agent dispatch (the subagent literally cannot be dispatched). Result: every Stop-hook turn re-fired the same review-pending prompt with a "rejected verdict" warning, and the assistant could neither dispatch (impossible) nor escape (rejected). User reported this as an infinite loop on 2026-05-11.
- **Fix** (`engine/apply-mutations.mjs`): the detector now recognizes the escape-hatch pattern (`status=REVISE` AND text starts with `unavailable`, case-insensitive, after optional leading whitespace) and routes it through a distinct flow: cursor is marked `blocked` immediately (not after the 3-strike threshold) with a `blocker_reason` carrying the three recovery options (`/goal-approve` / register agent / revise plan). The verdict is logged with `payload.escape_hatch=true` rather than `payload.rejected=true`.
- **`prompts/continuation-blocked.md`** — added a conditional `## ⚠ Reviewer agent unavailable in this environment` section that surfaces when the cursor was blocked via the escape-hatch path. Lists the three recovery commands with copy-paste-ready bodies (manual approve / register `~/.claude/agents/<name>.md` / revise plan).
- **`engine/stop-hook.mjs`** — when rendering `continuation-blocked.md`, walk back from the most recent `node-blocked` event and populate `ctx.unavailable_reviewers` / `ctx.unavailable_reviewers_csv` if `payload.escape_hatch === true`. Otherwise the section is omitted.

### Tests

- **`tests/escape-hatch.test.mjs`** — 10 new regression tests covering: blocking on first occurrence, history event shape, distinction from fabricated verdicts, case-insensitive matching, leading-whitespace tolerance, non-REVISE statuses not triggering the path, mid-sentence "unavailable" not triggering, multi-reviewer combined blocker reason, and pursuing-state no-op (matches existing applyMutations contract). All pass.
- Updated `tests/__snapshots__/continuation.test.mjs.snap` to reflect the new conditional section in `continuation-blocked.md` (empty when `unavailable_reviewers` is absent).

### Test suite

- 819 pass / 2 skip / 0 fail across 45 files (was 809 in v2.0.0; +10 from this hotfix).

### Why this slipped past v2.0.0 G1 gates

The G1 acceptance gates verified reducer determinism, replay perf, migration correctness, crash recovery, purity, and self-meta against the goal-mode self-improvement goal — none of them exercise the **end-to-end live Stop-hook prompt loop** under "reviewer unavailable" conditions. The Mancelot project (where reviewer registration is project-specific) hit the real-world case first. v2.1.0 backlog now includes a synthetic Stop-hook loop test as G2.X to prevent this class of regression.

## [2.0.0] — 2026-05-11

**General Availability.** All 7 ADR-0001 G1 acceptance gates closed. ADR-0001 (event log) + ADR-0002 (concurrent session locking) shipped. Phase 9 perf + purity gates land.

### Added

- **`tests/replay-benchmark.test.mjs`** — performance benchmarks closing **G1.3** (cold replay) and **G1.4** (warm replay snapshot+tail).
  - G1.3: reduce 10,000 events from genesis. Measured **p50=1.9ms, p99=2.3ms** on M1 — **250× under the 500ms SLO**.
  - G1.4: snapshot at seq=9000 + 1,000-event tail replay. Measured **p50=4.8ms, p99=5.6ms** — 20× under the 100ms SLO.
  - 5 runs per benchmark, median + p99 reported. JIT warm-up run excluded.
- **`tests/reducer-purity.test.mjs`** — closes **G1.6** by source-grep enforcement: `engine/reducer.mjs` MUST NOT use `Date.now`, `new Date()`, `Math.random`, `crypto.randomUUID`, any `node:fs` / `node:child_process` / `node:net` / `node:http*` import, `process.env`, `process.argv`, `process.std*.write`, or `console.*`. Imports restricted to `./traversal.mjs` only. 16 individual assertions; if any forbidden pattern appears, the test reports exact line.

### Acceptance gates — all 7 G1 closed ✅

| Gate | Status | Where |
|---|---|---|
| G1.1 Property-based reducer determinism | ✅ | alpha1 (fast-check 50×50 sequences) |
| G1.2 v1→v2 migration replay correctness | ✅ | rc1 |
| G1.3 Cold replay 10k events <500ms p50 | ✅ | **GA** (measured 1.9ms — 250× headroom) |
| G1.4 Warm replay snap+tail <100ms p50 | ✅ | **GA** (measured 4.8ms — 20× headroom) |
| G1.5 Crash injection recovery (5 modes) | ✅ | rc2 |
| G1.6 Reducer purity lint (no I/O, no clock, no random) | ✅ | **GA** |
| G1.7 Self-meta-test against live goal-mode goal | ✅ | rc2 |

Plus G2.1-G2.3 from v1.3.0 (locking).

### Changed

- **Phase 8 reader-switch cutover deferred to v2.1.0.** The `loadState`/`loadTree` cutover (event log canonical for reads) requires `apply-mutations.mjs` to be refactored to be event-driven, otherwise dual-write produces doubled mutations (saveState bakes in evidence/cursor + reducer re-applies on read). Filed as a known limitation: events.jsonl is canonical for recovery + forensics; state.json/tree.json remain primary read path until v2.1.0. The `cache-freshness` doctor check (shipped in rc2) catches divergence.
- **`engine/lock.mjs::registerExitCleanup`** — properly removes ALL three signal listeners (exit + SIGINT + SIGTERM) on unregister. Earlier versions only removed `exit`, causing MaxListeners=10 warnings and progressive test-suite slowdown across many withLock calls in the same process. Test suite is now consistently <5s end-to-end (was hanging for >1000s on phase-4 multi-iteration before this fix).
- **README.md status section regex** widened to accept `release candidate` / `release` suffixes (rc-track headlines).

### Fixed

- **Infinite recursion in `loadStateFromEvents` → `loadTree` cycle** (caught + reverted during cutover exploration). When both `loadState` and `loadTree` would have routed through `loadStateFromEvents`, and `loadStateFromEvents` calls `loadTree` for the seed tree without `legacyJson: true`, infinite recursion. Resolution: cutover deferred to v2.1.0; documentation update noted the trap for future implementations.

### Tests

- 789 → **809 pass** (+20: 4 benchmark + 16 purity). 2 skipped (1 pre-existing + 1 intentional self-meta skipIf). 0 failed.

### Open follow-ups (v2.1.0+)

- **v2.1.0 — Phase 8 reader-switch:** `apply-mutations.mjs` refactored to be event-driven (emit events, reducer applies, no direct tree mutation). After that, `loadState` safely routes through `loadStateFromEvents`. Add `state.last_event_seq` field to track which events are baked into the JSON cache for incremental replay.
- **v2.1.0 — ADR-0003 multi-goal:** `.claude/goals/active/` → `.claude/goals/<goal-id>/` with `.active` pointer + `/goal-list`/`/goal-switch`/`/goal-fork`/`/goal-delete`.
- **v2.2.0 — ADR-0004 plan-as-code:** Monorepo split, `@goal-mode/schema`, `@goal-mode/plan-dsl` npm packages.

## [2.0.0-rc2] — 2026-05-11

Second release candidate on the v2 track: **ADR-0001 Phase 7 landed**. Event log canonical for reads. `loadStateFromEvents` converted from async to sync (static imports, no circular dependency); writes back state.json + tree.json cache so legacy readers stay in sync. Two acceptance gates close: **G1.5 ✅** (crash injection recovery) and **G1.7 ✅** (self-meta against live goal-mode goal). New doctor check `cache-freshness` surfaces drift between cache and event log.

### Added

- **`engine/state.mjs::loadStateFromEvents`** is now **synchronous** (static imports of `snapshots`, `event-log`, `reducer`). The async version (alpha2) used dynamic imports as a circular-dep workaround; the cycle never materialised so static imports work cleanly. Adds `writeCache: boolean` option (default `true`) — on load, the reconstructed `{state, tree}` is atomically written back to state.json + tree.json so legacy `loadState`/`loadTree` reads see the same canonical data.
- **`engine/doctor.mjs::checkCacheFreshness`** — new doctor check. Compares `state.cursor` and `state.lifecycle` between the JSON cache and the replayed-from-events state. `fail` when cursor drifts; `warn` when lifecycle drifts. Auto-fix suggestion: re-run migrate-v1-to-v2 with `--force` (regenerates cache) OR delete state.json+tree.json and call `loadStateFromEvents` (auto-regenerates).
- **`tests/crash-injection.test.mjs`** — 8 tests covering 5 distinct crash modes per ADR-0001 §Crash recovery:
  - Crash A: state.json deleted mid-write → reconstructs + rewrites cache
  - Crash B: tree.json deleted → falls back to snapshot.tree or goal-created skeleton
  - Crash C: both state.json + tree.json corrupt → snapshot + events alone reconstruct fully
  - Crash D: events.jsonl trailing partial line → skip + valid prefix replay
  - Crash E: snapshot file corrupt → genesis replay fallback
  - Property variant: 5 corruption types in sequence, all converge to same ground-truth state
- **`tests/self-meta.test.mjs`** — 4 tests (1 intentional skipIf) against the live goal-mode self-improvement goal at `~/WebDev/claude-code-goal-mode/.claude/goals/active/`. Validates: loadStateFromEvents returns valid result (or graceful fallback), tree has expected 1 sprint + 6 epics + 32 tasks, doctor passes (allowing wallclock-budget-headroom warning on long sessions), schema_version current.

### Changed

- **`README.md` T1 regex** now accepts `release candidate` / `release` suffixes (was only stable/pre-release/alpha/beta/rc). v2.0.0-rc1's `release candidate` label was tripping the test; pattern relaxed to match the canonical phrasings.

### Acceptance gates

- **G1.1 ✅** (carried) — property-based reducer determinism
- **G1.2 ✅** (carried) — v1→v2 migration replay correctness
- **G1.5 ✅** — crash injection recovery (8 tests, 5 distinct crash modes, property variant)
- **G1.7 ✅** — self-meta-test against live goal-mode goal
- G1.3, G1.4 — Phase 9 (perf benchmark)
- G1.6 — Phase 9 (reducer purity lint rule)

### Tests

- 777 → **789 pass** (+12). 2 skipped (1 pre-existing + 1 self-meta skipIf branch). 0 failed.

### Open follow-ups (GA + Phase 9)

- **v2.0.0 GA (Phase 8):** Remove dual-write code. Make `loadState` route through `loadStateFromEvents` (the rename — current `loadState` reads JSON, will be replaced). Legacy state.json + tree.json writes become "regenerate from events" only, not separate writes from saveState. `state.history` is then derived from events instead of pushed-to directly.
- **v2.0.1 (Phase 9):** Replay benchmark (cold <500ms@10k, warm <100ms@10k → G1.3+G1.4), reducer purity CI lint rule (G1.6), event catalog docs.

## [2.0.0-rc1] — 2026-05-11

First release candidate on the v2 track: **ADR-0001 Phase 6 landed**. v1→v2 migration script reads existing `state.json` + `tree.json` + `state.history` and synthesises a believable initial event sequence (goal-created → plan-approved → started → per-history-entry events). Idempotent. Backup originals as `.pre-v2-migration-<ts>`. New doctor check `v2-migrated` surfaces migration status.

### Added

- **`engine/migrate-v1-to-v2.mjs`** — per ADR-0001 §Migration Phase C. Exports `migrateV1ToV2(projectRoot, opts?)` and `MigrationError`. CLI entry: `node engine/migrate-v1-to-v2.mjs [--force] [--cwd <path>]`. Outputs:
  - `events.jsonl` populated with N synthesized events at seq 0..N-1
  - `snapshots/snap-<N-1>.json` — final snapshot captures current state+tree (so reader-switch in rc2 doesn't re-replay from genesis on first load)
  - `state.json.pre-v2-migration-<ts>` + `tree.json.pre-v2-migration-<ts>` preserved backups
  - History event → v2 event mapping per ADR-0001 §Migration: `cursor-advanced`, `evidence-added`, `review-requested`, `review-verdict` → `audit-verdict-received`, `node-blocked`, lifecycle transitions (`paused`/`resumed`/`achieved`/`unmet`) → `lifecycle-changed`, `budget-exhausted`, `cleared`. `session-rebound` and `budget-warning` skipped (no v2 kind / informational).
  - Idempotent: `countEvents > 0` short-circuits unless `{ force: true }`.
- **`engine/doctor.mjs::checkV2Migrated`** — new doctor check reporting whether project is v2-native (event log only), v2-migrated (dual-write rc1 mode), or v1-not-migrated (warn + fix command).
- **`tests/migrate-v1-to-v2.test.mjs`** — 17 tests covering no-op paths, idempotency, force override, error on missing tree, synthesis correctness (goal-created at seq=0, plan-approved when approved_at set, started with full budget, history-entry mapping for cursor-advanced/review-verdict/paused/session-rebound-skipped), seq monotonicity, all events pass `EventLogEntrySchema.parse`, backup + final snapshot, and acceptance gate **G1.2** (replay of migrated events produces consistent state).

### Acceptance gates

- **G1.1 ✅** (carried) — property-based reducer determinism.
- **G1.2 ✅** — v1→v2 migration round-trip: replayed events produce state matching original v1 cursor + lifecycle. (Full byte-equivalence for `tree.evidence` requires reader-switch in rc2; current implementation scrubs skeleton then replays history, which produces semantically-equivalent but not necessarily byte-identical tree.)
- G1.3, G1.4 (perf), G1.5 (crash injection), G1.6 (lint), G1.7 (self-meta) — BLOCKED until rc2 and Phase 9.

### Tests

- 760 → **777 pass** (+17 migration tests). 1 pre-existing skip. 0 failed.

### Open follow-ups (rc2 + GA)

- **rc2 (Phase 7):** reader-switch. `loadState` / `loadTree` route through `loadStateFromEvents`. State.json + tree.json become regenerable cached views, no longer authoritative. Tests for crash injection (G1.5).
- **GA (Phase 8):** remove dual-write code. Single source of truth = events.jsonl + snapshots/.
- **Phase 9:** replay benchmark suite, reducer purity CI lint rule (G1.3, G1.4, G1.6).

## [2.0.0-alpha2] — 2026-05-11

Second pre-release on the v2 track: **ADR-0001 Phases 3–5 landed**. Snapshot generation + retention, Stop-hook transactional event batches via `appendTurnEvents`, new snapshot-aware read path `loadStateFromEvents`. Still dual-write (legacy `loadState` is canonical read; reader-switch is rc2).

### Added

- **`engine/snapshots.mjs`** — per ADR-0001 §Read modes + §Snapshot policy. Exports: `writeSnapshot(projectRoot, seq, state, tree)`, `findLatestSnapshot`, `listSnapshots`, `replayFromSnapshot`, `gcSnapshots`, `shouldSnapshot(turnEvents, before, after)`, `snapshotAndGc`. Filename layout `snap-<10-digit-padded-seq>.json` so lexicographic sort == numeric sort. Default policy: trigger on every `cursor-advanced` + `cleared` event, every `SNAPSHOT_INTERVAL=50` events, keep last `SNAPSHOT_KEEP=5`.
- **`engine/state.mjs::loadStateFromEvents(projectRoot, opts?)`** — async snapshot-aware loader. Composes findLatestSnapshot + readEvents (tail-only) + reducer. Falls back to seed tree from disk or `goal-created` event's `tree_skeleton` when no snapshot exists. Coexists with legacy sync `loadState` until rc2 reader-switch.
- **`tests/snapshots.test.mjs`** — 25 tests: schema, write/find/list, replay-from-snapshot variants (empty / with seed / tail filter / seq <= snapshot ignored), gc retention, `shouldSnapshot` policy (cursor-advanced / cleared / interval crossing / routine no-op).
- **`tests/load-state-from-events.test.mjs`** — 6 end-to-end tests covering missing log, replay-from-events-no-snapshot, snapshot + tail composition, transactional turn batches, `goal-created` seed from event log.

### Changed

- **Stop hook now emits events transactionally via `appendTurnEvents`.** All events from one turn share a single `turn_id` + consecutive `seq` values via one `appendFileSync` call — atomic at POSIX level. Replaces the old "loop with single-event appendEvent calls" path. `buildTurnEventPartials(newState, turnHistory, ts)` builds the ordered partial list (budget-tally always first, then per-history-entry mapped events). Old `emitEventForHistoryEntry` retained as legacy helper for ad-hoc callers.
- **Stop hook auto-snapshots after eligible turns.** `snapshotAndGc(projectRoot, seqAfter, newState, newTree)` runs when `shouldSnapshot` returns true (cursor advance, lifecycle clear, or interval crossing). Snapshot retention enforced (default 5 newest).
- **Adversarial-final T1 test relaxed for pre-releases.** Was: `v<X> — stable` regex (fails for any non-stable). Now: `v<X> — (stable|pre-release|alpha\d*|beta\d*|rc\d*)`. Lets the README correctly mark v2.0.0-alpha\* as pre-release instead of falsely claiming stable.

### Tests

- 729 → **760 pass** (+31: 25 snapshot + 6 load-from-events). 1 pre-existing skip. 0 failed.

### Acceptance gates

- **G1.1 ✅** (property-based determinism) — carried from alpha1.
- **G1.4 partial** — snapshot path exists; benchmark not yet run. Phase 9 closes.
- G1.5, G1.7 — still BLOCKED until reader-switch (rc2) and migration script.

### Open follow-ups

- **rc1**: Phase 6 migration script (`engine/migrate-v1-to-v2.mjs`) — synthesise events.jsonl from existing v1.x `state.history` + `tree.json`. Idempotent.
- **rc2**: Phase 7 reader-switch — make `loadState` route through `loadStateFromEvents`. State.json + tree.json become regenerable cached views.
- **GA**: Phase 8 cleanup — remove legacy dual-write code, snapshot policy as the only persistence write path.
- **Phase 9**: replay benchmark suite (`<500ms cold @ 10k events`, `<100ms warm`); reducer purity lint rule.

## [2.0.0-alpha1] — 2026-05-11

First pre-release on the v2 track: **ADR-0001 Phases 0–2 landed**. Event taxonomy spec-compliant (15 canonical kinds per ADR-0001 §Event taxonomy), per-event header (ULID id, monotonic seq, goal_id, schema_version, turn_id), per-kind zod payload schemas, pure-function reducer with property-based determinism test passing (acceptance gate **G1.1 ✅**).

This is **dual-write alpha** — `events.jsonl` is canonical-shape but `state.json` + `tree.json` still drive reads (per ADR-0001 §Migration Phase A). Reader-switch is rc2 (separate release).

### Added

- **`engine/event-payloads.mjs`** — 15 zod payload schemas, one per ADR-0001 event kind (`goal-created`, `plan-approved`, `started`, `iteration-began`, `evidence-added`, `task-status-asserted`, `cursor-advanced`, `review-requested`, `audit-verdict-received`, `node-blocked`, `lifecycle-changed`, `budget-tally`, `budget-exhausted`, `manual-approve-applied`, `cleared`). `validatePayload(kind, payload)` dispatches.
- **`engine/event-log.mjs`** rewritten to the spec: ULID ids (sortable), monotonic `seq` counter scoped to the goal, `goal_id` header field, `turn_id` for transactional grouping, `event_schema_version` per event. New `appendTurnEvents(projectRoot, turnId, partials)` writes multiple events with consecutive seq + shared turn_id in a single `appendFileSync` call.
- **`engine/reducer.mjs`** — pure function `reduce(initialTree, events, initialState?)` returning `{state, tree, applied, skipped}`. All 15 ADR kinds implemented. Per ADR-0001 §Reducer invariants: pure (no `Date.now`, no `Math.random`, no I/O), deterministic, schema-versioned dispatch.
- **Backward-compat read of v1.2.x events** via `MIGRATION_KIND_MAP` in `event-log.mjs::readEvents({migrate: true})`. Renames `evidence-recorded`→`evidence-added`, `goal-started`→`started`, `review-verdict-accepted/-rejected`→`audit-verdict-received`, `blocker-set`→`node-blocked`, `budget-tick`→`budget-tally`. Best-effort up-migration on read; never modifies disk.
- **`tests/reducer.test.mjs`** — 18 tests: 15 per-kind branch verification + 2 fast-check property tests (replay determinism + prefix-tail equivalence) + 1 purity verification (Date.now stub independence). Property tests use 50 random sequences each.
- **`tests/event-log.test.mjs`** rewritten — 22 tests covering taxonomy spec (exactly 15 kinds), event schema, seq monotonicity, ULID id format, turn_id transactional grouping, invalid-kind/payload rejection, atomic-rejection on bad turn (any invalid → entire turn fails), v1.2.x legacy row skip-by-default + opt-in migration via `readEvents({migrate: true})`.
- **`docs/architecture/versioning.md`** — release-tracker matrix mapping ADR → version → breaking-change status → migration commands → rollback paths. (Carried in from v1.3.0; this release amends Released section.)
- **`docs/architecture/acceptance-gates.md`** — testable ship criteria per ADR. ADR-0001: **G1.1 PASS** (property-based determinism). G1.2–G1.7 remain BLOCKED until rc1/rc2/GA.

### Changed

- **`engine/state-from-events.mjs::replayEvents`** is now a compat shim that delegates to `engine/reducer.mjs::reduce`. Existing v1.2.x callers (`loadStateWithRecovery`, `tests/event-log.test.mjs` legacy, `tests/v1.2.1-patches.test.mjs`) continue to work without modification.
- **`engine/start-goal.mjs`** and **`engine/stop-hook.mjs`** emit events using new spec kinds: `goal-started` → `started`, `budget-tick` → `budget-tally`, `evidence-recorded` → `evidence-added`, `blocker-set` → `node-blocked`, `review-verdict-accepted/-rejected` → `audit-verdict-received` (single kind, `rejected` flag in payload). All emitters now pass `goal_id` at the header level.
- **`appendEvent` contract** — requires `goal_id` in partial (was optional). Caller-provided + per-goal lock guarantees monotonic seq.

### Fixed

- v1.2.x event-log shape drift from ADR-0001 §Event taxonomy. Pre-alpha events.jsonl files (any user with v1.2.0+ installed) are readable with `{ migrate: true }`; the implicit migration happens on first v2-aware load.

### Tests

- 711 → **729 pass** (+18 from reducer, replaced 16 event-log tests in-place). 1 pre-existing skipped (legacy adversarial test, not introduced by v2 work). 0 failed.

### Open follow-ups (Phase 3 onwards — rc1/rc2/GA)

- Phase 3: snapshot management (`engine/snapshots.mjs`) — `writeSnapshot`, `findLatestSnapshot`, `replayFromSnapshot`, `gcSnapshots` per ADR §Read modes.
- Phase 4: full dual-write (rc1) — every CLI command + Stop hook emits its full event sequence via `appendTurnEvents`.
- Phase 5: reader switch (rc2) — `loadState` / `loadTree` route through reducer + snapshot replay.
- Phase 6: one-time `engine/migrate-v1-to-v2.mjs` migration script for existing v1.x projects.
- Phase 7-8: Stop-hook integration + cleanup of legacy code.
- Phase 9: replay benchmark (`<500ms cold for 10k events`, `<100ms warm`).

## [1.3.0] — 2026-05-11

First v2-track ADR landed: **ADR-0002 concurrent session locking**. File-based advisory lock (`engine/lock.mjs`) serializes write-intent operations across the Stop hook and all 7 CLI scripts. Eliminates the three race scenarios documented in ADR-0002 Context (Stop-hook-vs-CLI, Stop-hook-vs-Stop-hook cross-session, Stop-hook-vs-manual-edit). Additive — no breaking changes for v1.x users; existing single-session workflows continue unchanged.

### Added

- **`engine/lock.mjs`** — file-based advisory lock primitive per ADR-0002. Surface: `acquireLock` / `acquireLockSync` / `releaseLock` / `isLocked` / `breakStaleLock` / `withLock` / `withLockSync`. PID + host + acquired_at + ttl_seconds recorded in `.lock` JSON file. Stale detection via `process.kill(pid, 0)` liveness probe (host-local) + TTL fallback (cross-host conservative). Exponential backoff (100ms → 1600ms) with jitter on contention. Default 5s timeout, 30s TTL. `LockTimeoutError` carries holder info for diagnostic.
- **`tests/lock.test.mjs`** — 25 unit tests: schema validation, acquire/release happy paths, contention (second blocks until first releases, timeout raises with holder info), stale detection (dead PID, expired TTL, cross-host conservative), force override, release with mismatched pid, withLock cleanup on exception, default TTL constant.
- **`tests/lock-contention.test.mjs`** — 3 cross-process tests via subprocess spawn: two concurrent acquirers serialize (no overlapping hold intervals), three concurrent all succeed, SIGKILL-mid-hold leaves stale lock that next acquirer breaks.
- **`docs/architecture/versioning.md`** — release-tracker matrix mapping ADR → version → breaking-change status → migration commands → rollback paths.
- **`docs/architecture/acceptance-gates.md`** — explicit testable ship criteria per ADR. ADR-0002 gates: G2.1 primitive correctness (PASS), G2.2 multi-process contention (PASS), G2.3 wired into write sites (PASS), G2.4 Stop-hook contention test (BLOCKED — follow-up patch), G2.5 Mancelot dogfood (BLOCKED — awaiting deployment).

### Changed

- **All 7 write-intent engine functions acquire the lock**: `startGoal`, `approvePlan`, `pauseGoal`, `resumeGoal`, `clearGoal`, `abandonGoal`, `manualApprove` wrap their body in `withLockSync(activeDir(projectRoot), '<intent>', {}, () => { ... })`. Read-only paths (`render-status`, `loadState`, `loadTree`) intentionally do NOT acquire — consistent with ADR-0002 §Use sites.
- **`runStopHook` acquires the lock at entry, releases in `finally`**. Lock timeout (5s) → null stdout with stderr diagnostic instead of throwing. Conversation pauses gracefully on contention; Claude Code interprets null stdout as "no continuation needed this turn".
- **D1 plan G1 clarification**: `docs/superpowers/plans/2026-05-10-goal-mode-v2-d1-event-log.md` precondition block expanded to explicitly note that D1 ships against legacy `active/` namespace; the D4 mass-rename to `<goal-id>/` happens in v2.1.0 AFTER D1's v2.0.0 ships.

### Fixed

- N/A — additive release. No behavior change for users not running concurrent goal-mode operations.

## [1.2.1] — 2026-05-11

Patch release closing the ten honest gaps from the v1.2.0 self-critique: replay completeness, rejected-verdict visibility, retention/rotation, `doctor --fix`, `goal-tree` command, atomic event-first write order.

### Added

- **`goal-started` + `budget-tick` event kinds.** `start-goal` emits `goal-started` carrying full initial config (goal_id, session_id, cursor, started_at, budget). Stop hook emits `budget-tick` every iteration with cumulative `iterations_used` / `tokens_used`. Replay (`state-from-events.mjs`) consumes both — recovered state now has accurate budget counters + session id (v1.2.0 defaulted to 0/synthetic).
- **`doctor --fix` mode.** Safe auto-fixes: delete `.broken-*` backups; trim `.pre-migration-v*` backups to last 3. CLI re-checks afterwards.
- **`doctor --json` mode.** Machine-readable report for CI / monitoring.
- **`/goal-mode:goal-tree` command.** Renders plan as ASCII tree with status glyphs (`✓` achieved, `▶` pursuing, `🔵` review-pending, `⛔` blocked, `·` pending).
- **`pre-migration-backup-retention` doctor check.** Warns when more than 3 `.pre-migration-v*` backups accumulate.
- **Rejected verdicts surface in `continuation-review.md`.** When the engine rejects a fabricated verdict (v1.2.0 reviewer-independence enforcement), the agent now sees it in the next continuation prompt with agent name + reason. Closes the "invisible rejection → infinite loop" gap.

### Changed

- **Event-first atomic write order in stop hook.** `events.jsonl` is appended BEFORE `state.json` / `tree.json` saves. A crash between writes leaves events authoritative; recovery replays them.
- **`semver` dep replaces home-grown compare.** `checkPluginPinCurrent` handles pre-release tags (`1.2.0-rc1` < `1.2.0`) correctly.
- **Event log + state.history rotation.** When either exceeds 200 entries, older entries move to `.claude/goals/archive/events-<batch>.jsonl` / `history-<batch>.jsonl`.
- **`start-goal.mjs` writes `schema_version: CURRENT_SCHEMA_VERSION`** instead of hardcoded `1`.

### Fixed

- **`it.skip()` legacy repro test re-enabled** via proper vi.spyOn (admitted v1.2.0 tech debt).

## [1.2.0] — 2026-05-10

Stability & UX SOTA pass — six new product surfaces landed end-to-end against the goal-mode plugin itself driven as a real plan (`tree.json` in `.claude/goals/active/` of this repo).

### Added

- **`/goal-mode:goal-doctor`** — health diagnostic with 9 checks: state/tree validity, schema version, broken backups, cursor resolution, plugin pin freshness, Stop-hook liveness, budget headroom, event-log presence. Each check has a concrete fix command. `engine/doctor.mjs`, `engine/doctor-cli.mjs`, `scripts/doctor.sh`, `commands/goal-doctor.md`.
- **Schema migrations framework.** `engine/migrations.mjs` + per-step modules in `engine/migrations/`. Auto-applies on `loadState` / `loadTree` / `saveState` / `saveTree` / `validatePlan` when on-disk `schema_version` is older than `CURRENT_SCHEMA_VERSION`. Originals preserved as `.pre-migration-v<old>-<ts>` backups. First migration: v1 → v2 (canonicalising the `session-rebound` history event).
- **Progress bar in every continuation prompt.** ASCII Sprint / Epic / Task / Overall block with █/░ bars + percentages. `engine/progress.mjs`. Wired into `continuation.md`, `continuation-review.md`, `continuation-blocked.md`.
- **SessionStart auto-resume hook.** New CC session in a project with an active pursuing goal auto-injects the current continuation prompt — no more typing "продолжай" / "/goal-status" to re-engage. `hooks/session-start-hook.sh`, `engine/session-start-hook.mjs`, `engine/session-start-cli.mjs`. Declared in `hooks/hooks.json` SessionStart array.
- **Resume command UX rewrite.** Distinct actionable messages per lifecycle (pursuing → "already running, just send any message"; achieved → "/goal-clear --archive then /goal-plan"; missing → starter pointers). `engine/lifecycle-commands.mjs::resumeGoal`.
- **Reviewer-independence enforcement.** `<audit-verdict agent="X">` is accepted only when the transcript shows a real `Agent(subagent_type="X")` tool_use since the last `cursor-advanced` for the current cursor. Rejected verdicts produce a `review-verdict` history entry with `payload.rejected: true` and do not advance the cursor. `engine/transcript.mjs::scanAgentInvocations`, `engine/apply-mutations.mjs`, `engine/stop-hook.mjs`. Documented in `docs/architecture/reviewer-independence.md`.
- **Event-log architecture.** Append-only `events.jsonl` dual-written alongside `state.history`. Strict zod schema `EventLogEntrySchema`. Crash recovery via `loadStateWithRecovery` replays events to reconstruct missing state. `engine/event-log.mjs`, `engine/state-from-events.mjs`.
- **Two-layer output convention** (carried in from v1.1.22). Continuation prompts instruct assistants to write human-readable bullets ABOVE a `<details>` block containing machine tags. `parse-tags` finds tags inside `<details>` (verified with 3 regression tests in `tests/parse-tags.test.mjs`).

### Changed

- **`CURRENT_SCHEMA_VERSION` → 2.** `GoalStateSchema` and `GoalTreeSchema` now `z.literal(2)`. v1 states auto-migrate on load.
- **`install.sh` now updates `~/.claude/plugins/installed_plugins.json` pin.** Previously deploys to cache succeeded but the loader kept the old pinned version, requiring users to manually `/plugin update` (which doesn't exist in Desktop). Step 6 of install.sh closes this loop.
- **12 pre-existing adversarial-final tests** updated to match current shipping product (rewrote stale assertions about pre-v1.1.17 install.sh shape, pre-namespace slash command format, etc.).

### Fixed

- **`schema_version`-mismatch silent stall** (the v1.1.18 "engine встал" bug class). The historical pattern was: zod throws on save → outer catch swallows → returns null stdout → CC pauses conversation with no diagnostic. v1.2.0 catch-block emits the error as a continuation-prompt diagnostic (carried in from v1.1.20).

### Tests

- 660 pass · 2 skipped (legacy placeholders, removed in 1.2.1) · 33 test files.
- New: `tests/doctor.test.mjs` (29), `tests/migrations.test.mjs` (17), `tests/progress.test.mjs` (10), `tests/session-start-hook.test.mjs` (6), `tests/independence.test.mjs` (11), `tests/event-log.test.mjs` (16).

## [1.1.18] — 2026-05-10

Replaces v1.1.15's wildcard session_id workaround with a proper transcript-derived real session UUID. Maintains strict session-id matching in stop-hook so multi-session isolation works in both Desktop and CLI without any escape hatch. Source: a second-machine agent on the same project independently identified the same blocker, traced it via instrumented hook to the JSONL transcript directory, and proposed this fix verbatim.

### Fixed

- **`start-goal-cli.mjs` now resolves session_id via transcript dir, not wildcard.** Both CLI's standalone `claude` and Desktop's embedded `claude` write turn-by-turn transcripts to `~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl`. The basename (sans extension) of the most-recently-modified file in that dir IS the active session UUID — same value Stop-hook stdin delivers as `session_id`. Resolution order: (1) `CLAUDE_CODE_SESSION_ID` env var (set in standalone CLI), (2) transcript dir scan (works in both CLI and Desktop). If neither resolves (very-first-turn case), exits 2 with an actionable hint ("send any message first so a transcript file exists"), not the previous "Desktop unsupported" message. (`engine/start-goal-cli.mjs`)

- **`stop-hook.mjs` mismatch is now visible (was: silent no-op).** The session-id mismatch path used to `return {exit:0, stdout:null}` with no stderr — making it nearly impossible to diagnose when state was started in a different session. v1.1.18 emits `[goal-mode] Stop-hook short-circuit: state.session_id="X" ≠ stdin.session_id="Y". The active goal was started in a different Claude session. To recover, run /goal-mode:goal-clear and re-/goal-mode:goal-start, or jq-patch state.json to set session_id="Y".` Includes both ids and a recovery hint. (`engine/stop-hook.mjs`)

- **Wildcard `"*"` session_id removed from `stop-hook.mjs`.** No longer needed since `start-goal-cli.mjs` always resolves a real UUID. The wildcard was a v1.1.15 workaround that bypassed multi-session isolation; transcript-derived UUIDs preserve isolation in both environments. (`engine/stop-hook.mjs`)

### Tests

- **2 new tests for `deriveSessionIdFromTranscript`**: returns the basename of the most-recently-modified `.jsonl` (with explicit mtime fixtures so the test is deterministic), returns null when no transcripts exist. (`tests/start-goal.test.mjs`)
- **2 stop-hook tests rewritten**: one asserts strict-match happy path, one asserts mismatch produces stderr diagnostic with both ids + recovery hint (was 3 wildcard tests, removed since wildcard is gone). (`tests/phase-4-multi-iteration.test.mjs`)
- Test count unchanged at 297. Wildcard tests removed (3); transcript-derive tests added (2); stop-hook stderr test added (1). Net ±0.

### End-to-end smoke verified locally

Synthetic env with realistic `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl` layout:

```
$ unset CLAUDE_CODE_SESSION_ID && bash scripts/start-goal.sh --max-iter 5 ...
🎯 Goal pursuing — cursor: t, iter budget: 5, token budget: 100000, time budget: 3600s
(session id resolved from transcript: abc-fake-uuid-xyz)
Stop-hook is now active. Make your first move on this task.

$ jq .session_id state.json
"abc-fake-uuid-xyz"
```

Confirmed:
1. Without `CLAUDE_CODE_SESSION_ID` env var,
2. With a synthetic `.jsonl` named `abc-fake-uuid-xyz.jsonl` in the matching project transcript dir,
3. start-goal-cli derives the UUID and stores it as `state.session_id`.

Stop hook with stdin `session_id="abc-fake-uuid-xyz"` will then strict-match. Stop hook with stdin `session_id="other"` will emit the new stderr diagnostic.

### Credit

Diagnosis and proposed diff came from a second-machine agent on the same project, who instrumented the Stop hook with a probe that logged env vars to verify it actually fired in Desktop, then traced the silent no-op to the session-id mismatch and identified the JSONL transcript dir as the canonical source of the live UUID. The maintainer verified the probe on the first machine independently before adopting the fix. This release is a direct port of that diff with snake_case → camelCase normalisation (the function exports `deriveSessionIdFromTranscript`) and added `deriveSessionIdFromTranscript` is exported for the regression test.

[1.1.18]: https://github.com/lokafinnsw/claude-code-goal-mode/releases/tag/v1.1.18

## [1.1.17] — 2026-05-10

Reverses the v1.1.16 deprecation framing of `install.sh` and rewrites it to deploy to the same plugin cache as `/plugin install` — producing byte-equivalent end state.

### Why v1.1.16 was wrong

v1.1.16 deprecated `install.sh` on the assumption that Claude Desktop could now run `/plugin install` directly. Verified May 2026 via grep of the embedded Claude Code binary (`~/Library/Application Support/Claude/claude-code/<ver>/claude.app/.../claude`):

```
HA3={type:"local-jsx",name:"plugin",aliases:["plugins","marketplace"],...}
```

`/plugin` is `type: "local-jsx"`, and the dispatcher rejects local-jsx commands in non-interactive sessions:

```
if(Y.type==="local-jsx" && K.options.isNonInteractiveSession){
  ... `/${cmd} opens an interactive panel and isn't available in this environment. Run it from the Claude Code terminal instead.`
}
```

Same applies to `/plugin marketplace add`, `/plugin uninstall`, `/reload-plugins`. Pure-Desktop users (no terminal `claude`) cannot run any of them. install.sh is the only install path for that segment, not deprecated.

### Changed

- **`install.sh` rewritten** to deploy to `~/.claude/plugins/cache/goal-mode/goal-mode/<version>/` (same place `/plugin install` writes), copy `marketplace.json` to `~/.claude/plugins/marketplaces/goal-mode/`, register the marketplace in `~/.claude/plugins/known_marketplaces.json` with `autoUpdate: true`, and enable the plugin in `~/.claude/settings.json` (`extraKnownMarketplaces` + `enabledPlugins`). End state is byte-equivalent to `/plugin install`. Result: slash commands appear ONLY as `/goal-mode:goal-X` in the picker (canonical plugin namespace), no `/goal-X` duplicates, no double-firing Stop hooks, no parallel "user-global" deployment. (`install.sh`)

- **`install.sh --uninstall`** added: removes plugin cache dir, marketplace dir, jq-edits known_marketplaces.json + settings.json to drop the goal-mode entries.

- **README "Path B" section** rewritten: install.sh framed as "for Desktop-only users (no terminal CLI)", not deprecated. Documents that `/plugin install` is `local-jsx`-typed and rejected in non-interactive Claude Desktop sessions, citing the binary grep evidence. Cleanup recipe for users who used pre-v1.1.17 install.sh layout (those legacy artifacts in `~/.claude/commands/` + `settings.json` Stop hook) preserved.

### Notes — verification

End-to-end smoke verified locally on a synthetic env:
1. `HOME=/tmp/test bash install.sh` on clean state with no existing goal-mode plugin → produced `~/.claude/plugins/cache/goal-mode/goal-mode/<ver>/`, marketplace dir, known_marketplaces entry with autoUpdate, `enabledPlugins["goal-mode@goal-mode"]: true`. State byte-matches what `/plugin install` produces.
2. Re-run install.sh on existing install → idempotent (overwrites cache dir with current version, no errors).
3. `bash install.sh --uninstall` → removes all goal-mode artifacts, restores settings.json `enabledPlugins` to original.

Methodological lesson: v1.1.16 deprecated install.sh based on the false claim "Desktop = embedded CC = can run /plugin install". The correct claim was "Desktop = embedded CC = uses the same plugin LOADER", but `/plugin install` (the slash command) and the loader are different things. The slash command is a CLI-only TUI panel; the loader runs in any environment. install.sh now exploits that distinction by writing directly to the loader's cache location, bypassing the inaccessible CLI command.

[1.1.17]: https://github.com/lokafinnsw/claude-code-goal-mode/releases/tag/v1.1.17

## [1.1.16] — 2026-05-10

`install.sh` is deprecated. Single canonical install path now: `/plugin install goal-mode@goal-mode`. Verified via runtime probe that Claude Desktop embeds the same Claude Code binary as the terminal — install.sh's reason for existing ("Desktop can't /plugin install") is false in May 2026.

### Changed

- **`install.sh` is DEPRECATED.** Header rewritten to mark deprecated status, prints a deprecation warning on run, refuses to layer on top of an existing `/plugin install` (detects `~/.claude/plugins/cache/goal-mode/goal-mode/` and exits with cleanup instructions), waits 5s before continuing for users who genuinely need it (sandboxed envs without `/plugin`). Existing functionality unchanged for those edge cases. (`install.sh`)
- **README "Path B" section** rewritten to mark install.sh deprecated, point users at Path A (the `/plugin install` flow), and ship a one-liner cleanup recipe for users who previously layered both paths and now have duplicate slash commands plus double-firing Stop hooks. (`README.md`)

### Background — why this matters

Running `install.sh` AND `/plugin install` together creates two parallel goal-mode installations:
- `install.sh` deploys `~/.claude/commands/goal-*.md` (slash commands without plugin namespace, e.g. `/goal-status`) plus a `Stop` hook in `~/.claude/settings.json` pointing at the dev repo.
- `/plugin install` deploys `~/.claude/plugins/cache/goal-mode/goal-mode/<version>/` with namespaced commands (`/goal-mode:goal-status`) and the plugin's own auto-registered Stop hook.

The slash command picker shows BOTH sets, so users see `/goal-status` AND `/goal-mode:goal-status` (visible duplication in the autocomplete list). The Stop hook fires TWICE on every Claude Stop event — once from settings.json, once from the plugin loader — so state.json gets mutated twice per turn (iteration counter, evidence, cursor advances) and history events duplicate. v1.1.11 already detected stop-hook duplication via the `# goal-mode-installer-managed` marker, but only within install.sh's own re-runs — it could not deduplicate across install paths. The right fix is one canonical path.

### Notes

The maintainer's local machine had both paths active simultaneously (visible in the slash command list as `/goal-status` AND `/goal-mode:goal-status`) and three Stop hook entries in settings.json. Cleaned up manually:
- Removed 11 install.sh-deployed `~/.claude/commands/goal-*.md` files.
- Filtered out 2 install.sh-managed Stop hook entries from `settings.json` (kept any non-goal-mode hooks if present).
- Removed dangling `Bash(/Users/.../claude-code-goal-mode/{hooks,scripts}/*.sh:*)` permissions (no longer needed once install.sh hooks are gone — the plugin loader handles its own permission scope).

Result: only `/goal-mode:goal-X` commands appear in the picker, no duplicate Stop hooks. Same behavior, single canonical path.

[1.1.16]: https://github.com/lokafinnsw/claude-code-goal-mode/releases/tag/v1.1.16

## [1.1.15] — 2026-05-10

Fixes the last Claude Desktop blocker after v1.1.13: even though the slash command was reaching the script, `start-goal.sh` errored with `CLAUDE_CODE_SESSION_ID env var not set`.

### Methodology correction (1.1.15-rev)

The original v1.1.15 changelog explained this through "Desktop spawns Claude Code as SDK subprocess with `CLAUDE_CODE_ENTRYPOINT=sdk-ts`". That was reverse-engineered from `strings` of `app.asar` — STATIC binary analysis, not RUNTIME probe. A second-machine agent ran an actual probe hook in Desktop and reported `CLAUDE_CODE_ENTRYPOINT=claude-desktop`, which contradicted the static reading. A subsequent `env | grep CLAUDE` from a Desktop-spawned subprocess confirmed:

```
CLAUDE_CODE_ENTRYPOINT=claude-desktop      ← real value, not "sdk-ts"
CLAUDE_CODE_EXECPATH=/Users/.../Library/Application Support/Claude/claude-code/<ver>/claude.app/...
CLAUDECODE=1
CLAUDE_CODE_SESSION_ID: NOT SET            ← session id rides as --resume <uuid> CLI arg, not env var
parent process: /Applications/Claude.app/Contents/Helpers/disclaimer
```

Real Desktop architecture: it EMBEDS the same Claude Code binary used in the terminal (`~/Library/Application Support/Claude/claude-code/<ver>/claude.app/`), shares `~/.claude/`, runs the same hooks, and propagates session id as a CLI argument, not an env var. The `sdk-ts` value I cited was a default fallback in unreachable-from-Desktop code paths, not the runtime value.

The CODE FIX in v1.1.15 (wildcard fallback when env var unset) is still correct — it handles exactly the runtime condition above. The NARRATIVE was wrong. Inline comments in `start-goal-cli.mjs` and this changelog now describe the real probe data instead of the inferred binary path.

Lesson: probe runtime, don't grep binaries.

### Fixed

- **`/goal-start` now works in Claude Desktop without `CLAUDE_CODE_SESSION_ID`.** Real reason (per runtime probe, not binary inference): Desktop's embedded Claude Code receives `--resume <uuid>` as a CLI argument and does not set `CLAUDE_CODE_SESSION_ID` in the env of subprocesses it spawns (slash-command bash blocks, Bash-tool invocations, etc.). Our script reads `process.env.CLAUDE_CODE_SESSION_ID` and saw undefined → previously errored. Fix: `start-goal-cli.mjs` falls back to `session_id="*"` (wildcard) when the env var is unset, prints a notice that the goal is in no-session mode, and stores the wildcard in state.json. (`engine/start-goal-cli.mjs`)

- **Stop hook session-id matching now treats `"*"` as "match any incoming stdin.session_id".** Previously `state.session_id !== stdin.session_id` was a strict no-op for any mismatch — which meant Desktop hooks with random stdin session_ids never advanced the cursor. v1.1.15: wildcard sentinel bypasses the strict check while preserving multi-CLI-session protection (real session_ids still match strictly). (`engine/stop-hook.mjs`)

### Added

- **4 regression tests for wildcard mode:**
  - `tests/start-goal.test.mjs`: `accepts wildcard "*" sessionId (Desktop / no-CLI-session mode)` — verifies engine accepts `"*"` and stores it.
  - `tests/phase-4-multi-iteration.test.mjs`: 3 tests in new "Desktop / wildcard session_id mode" describe block:
    - wildcard accepts ANY incoming stdin session_id (Desktop happy path).
    - strict mismatch still no-ops (CLI multi-session protection preserved).
    - strict match still works (CLI happy path).
  - Test count: 293 → 297.

### Changed

- **README "Claude Desktop & Claude Code CLI both work" section** updated. Was: "since v1.1.13" with only the slash-command fix. Now: documents both v1.1.13 (slash-command parser) and v1.1.15 (autonomous continuation loop). Explicit about the wildcard trade-off for multi-session usage.

### Notes

End-to-end smoke verified locally:
1. `unset CLAUDE_CODE_SESSION_ID && bash scripts/start-goal.sh --max-iter 800 --token-budget 20000000 --time-budget 24h` → succeeds. Output: `🎯 Goal pursuing — cursor: ...` + `(Running in Desktop / no-session mode — all Claude sessions in this project will drive this goal.)` + `Stop-hook is now active.`
2. State: `lifecycle: pursuing`, `session_id: "*"`, `cursor: <first task>`.
3. `cat synthetic-stop-input.json | bash hooks/stop-hook.sh` (with stdin.session_id="random-desktop-id-xyz" — totally different from state's "*") → cursor advances, evidence applied, history grows. The Stop-hook pipeline runs end-to-end as if in CLI.

The reverse-engineering trail is preserved in the inline comments in `start-goal-cli.mjs` and `stop-hook.mjs` so a future maintainer doesn't have to re-extract `app.asar`.

[1.1.15]: https://github.com/lokafinnsw/claude-code-goal-mode/releases/tag/v1.1.15

## [1.1.14] — 2026-05-10

### Added

- **`fix-cli-source.sh` now also enables `autoUpdate: true`** for the goal-mode marketplace in `~/.claude/plugins/known_marketplaces.json` (idempotent: no change if already true). With autoUpdate on, Claude Code pulls the latest goal-mode from GitHub at every session start — no manual `/plugin marketplace update goal-mode` per release. This is the same default that ships with `thedotmack/claude-mem` and other auto-tracked third-party marketplaces. (`scripts/fix-cli-source.sh`)
- **README "Auto-update" section** with the one-liner JQ recipe and the `bash <(curl -sL .../fix-cli-source.sh)` path for users who haven't cloned. (`README.md`)

### Notes

End-to-end smoke verified locally on a synthetic `~/.claude/plugins/known_marketplaces.json`:
- 1st run: detects MISSING autoUpdate, sets it to true, writes timestamped backup.
- 2nd run: detects true already, no change, no error.

The `autoUpdate` field is per-user and lives only in `~/.claude/plugins/known_marketplaces.json` — it cannot be shipped in the repo's `marketplace.json`. The `fix-cli-source.sh` migration is the deployment path; users who don't run it can use the `jq | sponge` one-liner from the README.

[1.1.14]: https://github.com/lokafinnsw/claude-code-goal-mode/releases/tag/v1.1.14

## [1.1.13] — 2026-05-10

Fixes the real Claude Desktop blocker: 6 commands using `$ARGUMENTS` shell expansion in their markdown were silently rejected by Desktop's slash-command parser (regardless of whether the user passed args), making `/goal-start`, `/goal-plan`, `/goal-plan-from-file`, `/goal-approve`, `/goal-abandon`, `/goal-clear` unusable in Desktop. v1.1.12 documented this as a Desktop limitation. v1.1.13 actually fixes it.

### Fixed

- **All 11 commands now work in both Claude Code CLI and Claude Desktop.** Root cause of the Desktop rejection: 6 of the command files (`commands/goal-start.md`, `goal-plan.md`, `goal-plan-from-file.md`, `goal-approve.md`, `goal-abandon.md`, `goal-clear.md`) used the `$ARGUMENTS` placeholder inside a `\`\`\`!` shell block. Claude Code CLI expands `$ARGUMENTS` before executing the block; Claude Desktop does not, and its parser rejects the whole command with "isn't a recognized command here" — even when the user types the command with no args. Fix: switch from `$ARGUMENTS`-substitution to a natural-language pattern. The command markdown now instructs the agent to parse the user's typed flags from their message and dispatch the underlying script via Bash with the parsed values. The agent does the parsing in either environment, so the same `/goal-start --max-iter 800` works identically in Desktop and CLI. (`commands/goal-start.md`, `commands/goal-plan.md`, `commands/goal-plan-from-file.md`, `commands/goal-approve.md`, `commands/goal-abandon.md`, `commands/goal-clear.md`)

### Changed

- **README "Claude Desktop limitations" section** rewritten to reflect that the limitation is gone in v1.1.13. The previous text said "no clean workaround"; that was true at the time given the v1.1.12 codebase, but the natural-language pattern in v1.1.13 IS the workaround. (`README.md`)

### Notes

End-to-end smoke verified locally on the maintainer's mancelot test target:
- All shim scripts (start-goal.sh, etc.) still accept the same `--flag` syntax — only the command-markdown layer changed. The agent now reads the user's message, parses flags, and invokes the script with explicit arguments via the Bash tool. This means CLI users keep their familiar `/goal-start --max-iter 800` UX, and Desktop users get the same flow without hitting the parser rejection.
- The 5 zero-arg commands (`goal-help`, `goal-status`, `goal-pause`, `goal-resume`, `goal-approve-plan`) still use the inline `\`\`\`!` shell-block pattern — no change there.
- Test count unchanged at 293; no test asserts on `$ARGUMENTS` literal in committed test files.

[1.1.13]: https://github.com/lokafinnsw/claude-code-goal-mode/releases/tag/v1.1.13

## [1.1.12] — 2026-05-10

Closes the M1-M7 tech-debt list from REAL-USAGE-FINDINGS plus a documented Claude Desktop limitation discovered when `/goal-start --max-iter ...` failed in Desktop with "isn't a recognized command here".

### Fixed

- **M1: Inconsistent "no active goal" casing.** `clear-cli.mjs` printed `no active goal` (lowercase, no period); `render-status-cli.mjs` printed `No active goal.` (capitalized). Lifecycle errors in `lifecycle-commands.mjs` and `manual-approve.mjs` also returned lowercase. Fix: all four code paths now return `No active goal.` (capitalized + period). Tests use `/no active goal/i` (case-insensitive) so no test changes needed. (`engine/clear-cli.mjs`, `engine/lifecycle-commands.mjs`, `engine/manual-approve.mjs`)

- **M2: `approve-plan-cli` silently accepted unknown args** (e.g., `--dry-run` was ignored without warning, leading users to think the flag worked). Fix: any non-empty arg list rejected with `Unknown arguments: <args>` + usage hint, exit 2. (`engine/approve-plan-cli.mjs`)

- **M5: `start-goal-cli` silently ignored unknown args.** Same pattern — typos like `--max-iters` (extra s) just got dropped, default kept. Fix: explicit `else` branch in arg loop rejects unknown args with usage hint, exit 2. (`engine/start-goal-cli.mjs`)

- **M2 + M5 also applied to `clear-cli.mjs`, `abandon-cli.mjs`, `approve-cli.mjs`** for consistency. Each rejects unknown args with usage hint.

- **M6: `start-goal-cli` env-var-missing error did not hint at the cause.** When `CLAUDE_CODE_SESSION_ID` was unset, the message said only "this command must run inside a Claude Code session" — but the most common cause is a user running it from Claude Desktop, where the env var is never set because Desktop has no plugin loader. Fix: error now explicitly says "the terminal app, not Claude Desktop" + reference to the new README "Claude Desktop limitations" section. (`engine/start-goal-cli.mjs`)

- **M3: Continuation prompts (continuation.md, continuation-blocked.md, audit-instructions.md) emitted blank lines between Mustache `{{#each}}` items.** Each iteration produced `\n- item\n`, but the `{{#each}}` tag itself was on its own line ending with `\n`, so the rendered output had an extra blank line before AND after the loop body. Lists looked spacey. Fix: inline the `{{#each}}` tag with the first content line so the loop body emits items contiguously. Verified: 2-item criteria render as `- a\n- b\n`, no blank lines between. Snapshot tests regenerated. (`prompts/continuation.md`, `prompts/continuation-blocked.md`, `prompts/audit-instructions.md`, `tests/__snapshots__/continuation.test.mjs.snap`)

- **M4: `plan-bootstrap.md` mandated only 2 output files (tree.json + plan.md), while `plan-from-file.md` mandated 3 (tree.json + plan.md + state.json).** This asymmetry meant `/goal-plan` left the user without a `state.json`, so `/goal-approve-plan` had to synthesize one — and the user's manual edit window between plan and approve had no consistent state shape to reason about. Fix: plan-bootstrap.md now mandates all 3 files in this single turn (matching plan-from-file.md), with the same minimal-draft state.json shape (lifecycle: draft, cursor: pending, history: []). (`prompts/plan-bootstrap.md`)

- **M7: `fix-cli-source.sh --help` was missing.** Users running the script without context saw it act on `~/.claude/` immediately (with backups, but still surprising). Fix: `--help` and `-h` now print background, usage, what-it-does, and exit codes; main script body unchanged when no help flag. (`scripts/fix-cli-source.sh`)

### Added — Claude Desktop limitations (documentation)

- **README "Claude Desktop limitations" section** between Installation and Switching paths. Documents two limits versus Claude Code CLI:
  1. `$ARGUMENTS` is CLI-only. Slash commands taking arguments (`/goal-start`, `/goal-plan`, `/goal-plan-from-file`, `/goal-approve --reason`, `/goal-abandon --reason`, `/goal-clear --archive`) emit "isn't a recognized command here" in Desktop. Run from CLI instead.
  2. Zero-arg commands (`/goal-help`, `/goal-status`, `/goal-pause`, `/goal-resume`, `/goal-approve-plan`) work in both.

  The recommended workflow if a user primarily uses Desktop: run `/goal-plan` and `/goal-start` once from CLI to bootstrap the active goal, then drive the Stop-hook loop from Desktop with no further argument-bearing commands needed.

  This is a Claude Desktop limitation, not a goal-mode bug. Documented so a future user hitting the same `/goal-start` rejection in Desktop has a clear answer + workaround. (`README.md`)

### Notes

`engine/lifecycle-commands.mjs` returns `{ ok: false, error: 'No active goal.' }` (capitalized + period). The two-call sites in `engine/clear-cli.mjs` (the `noop` branch) and `engine/render-status-cli.mjs` already used the capitalized form. Test count unchanged at 293; only snapshots updated.

End-to-end smoke verification of all 7 M-fixes done locally:
- M2: `bash scripts/approve-plan.sh --dry-run` → `Unknown arguments: --dry-run\nUsage: /goal-approve-plan (no arguments)` (was: silent acceptance).
- M5: `bash scripts/start-goal.sh --bogus` → `Unknown argument: --bogus\nUsage: /goal-start [...]` (was: silent acceptance, default kept).
- M6: `bash scripts/start-goal.sh` (no env var) → 3-line error with Desktop hint (was: 1 line, no Desktop reference).
- M7: `bash scripts/fix-cli-source.sh --help` → multi-line help block + exit 0 (was: no flag, ran on $HOME immediately).
- M3: rendered continuation.md shows `- [ ] (#0) a\n- [x] (#1) b\n\n## Already...` (no blank line between criteria items; one blank line before next section, which is normal markdown).

[1.1.12]: https://github.com/lokafinnsw/claude-code-goal-mode/releases/tag/v1.1.12

## [1.1.11] — 2026-05-10

Fixes 4 bugs uncovered by REAL-USAGE-FINDINGS testing (synthetic-fixture run on Darwin arm64, Node 25.9.0). Two Critical, two Important; +5 regression tests.

### Fixed

- **Critical C1: `install.sh` Stop-hook dedup matched on the literal substring "goal-mode" in the repo path**, so users who cloned to a directory whose name did NOT contain "goal-mode" (e.g. `~/devtools/gm-plugin/`) would accumulate Stop-hook entries on every re-run of install.sh. After 3 re-runs that user had 3 duplicated goal-mode entries plus the unrelated ones — every Claude Stop event ran the goal-mode hook 3 times, runaway resource consumption. Fix: inject literal marker comment `# goal-mode-installer-managed` into the hook command string and dedup by marker (path-independent). Bash treats `#` as comment, so the marker has no runtime effect. (`install.sh`)

- **Critical C2: `install.sh` against malformed `~/.claude/settings.json` left an orphan `settings.json.new` file (0 bytes) and exited with raw jq parse error** — no user-facing explanation that the existing settings was the problem, no cleanup, no remediation hint. Fix: preflight `jq -e .` validation BEFORE the transform; if it fails, print actionable error ("Inspect with: jq . $SETTINGS  # to see the parse error location") and exit 1. Add `trap 'rm -f "$SETTINGS.new"' EXIT` to clean up orphan files even on unexpected failures. (`install.sh`)

- **Important I1: `/goal-status` reported "No active goal" when `tree.json` was corrupt but `state.json` was intact** — `loadTree()` renamed corrupt tree to `.broken-<ts>-<seq>` and returned null, falling through to the no-goal message. Tempted user to run `/goal-plan` which OVERWRITES state.json, destroying surviving history. This is a destroy-data path. Fix: new branch in `renderStatusReport` for partial corruption — surfaces "corrupt state" warning, lists forensic copies (up to 3 + count), prints lifecycle/goal_id of preserved state, gives explicit recovery steps, ends with "Do NOT run /goal-plan or /goal-start until tree.json is restored." (`engine/render-status-cli.mjs`)

- **Important I2: `<audit-verdict status="go">` (lowercase) silently dropped** — `VERDICT_VALUES = new Set(['GO', 'NOGO', 'REVISE'])` did strict-case lookup, so real-world LLM lowercase output never registered. Review loop hung; after 3 NOGO iterations the engine escalated lifecycle to "unmet" without a real reason. Fix: `(attrs.status ?? '').toUpperCase()` before Set lookup. Lowercase, mixed-case, and `Revise`/`go`/`nogo` all parse correctly and are stored uppercase in the canonical output. (`engine/parse-tags.mjs`)

- **README staleness: status badge hardcoded `1.0.0` while package.json was at 1.1.10**, failing T1a/T1b doc-staleness regression tests. Fix: switched to dynamic shields.io badge `https://img.shields.io/github/v/tag/lokafinnsw/claude-code-goal-mode?label=release&color=brightgreen` that auto-tracks the latest GitHub tag. No more manual badge bumps per release. (`README.md`)

### Added

- **5 regression tests** locking the I1 + I2 fixes:
  - `tests/parse-tags.test.mjs`: `accepts lowercase verdict status`, `drops audit-verdict with empty status`. Asserts lowercase `go`/`nogo`/`Revise` produce uppercase `GO`/`NOGO`/`REVISE` in canonical output.
  - `tests/render-status-cli.test.mjs`: 3 new tests covering tree-corrupt-state-intact, state-corrupt-tree-intact, and only-forensic-copies-remain branches. Each asserts the warning surfaces and the dangerous "No active goal" message is NOT emitted.
  - Test count: 288 → 293.

### Notes

C1 and C2 are bash-script bugs, end-to-end verified locally:
- C1: synthetic `/tmp/install-tests/gm-plugin/` (no "goal-mode" in path), 2 install.sh runs against settings.json with 2 unrelated Stop hooks. Result: 3 entries after run 1, still 3 after run 2 (idempotent).
- C2: synthetic `{ "hooks": { broken` settings.json. Result: clean error message, no orphan .new file, settings.json untouched.

I1 and I2 are JS bugs, locked by the new regression tests above.

[1.1.11]: https://github.com/lokafinnsw/claude-code-goal-mode/releases/tag/v1.1.11

## [1.1.10] — 2026-05-10

### Fixed

- **`install.sh` "Next steps" echo block still printed `/goal:X` syntax.** The bulk replace in v1.1.9 hit `prompts/`, `commands/`, `README.md`, `docs/` but missed `install.sh` itself. After re-running `bash install.sh` post-1.1.9, users would see "type /goal:help in Claude" — but `/goal:help` does not exist; the working command is `/goal-help`. Fix: replaced 5 references to `/goal:X` in install.sh's echo block with `/goal-X`. (`install.sh`)

### Notes

End-to-end smoke verification was performed by the maintainer:

1. `bash install.sh` redeploys 11 commands to `~/.claude/commands/goal-X.md` with `${CLAUDE_PLUGIN_ROOT}` substituted to absolute paths.
2. `unset CLAUDE_PLUGIN_ROOT && bash scripts/approve-plan.sh` (simulating Claude Desktop's invocation, since Desktop has no plugin loader to set the env var) succeeds with `✅ plan approved (304 tasks)` instead of crashing with `unbound variable`. The defensive default in v1.1.9 derives `CLAUDE_PLUGIN_ROOT` from `BASH_SOURCE`.

Side effect of step 2: the test target was the maintainer's local `mancelot-only-mans/.claude/goals/active/tree.json`, so this run actually advanced its lifecycle from `draft` to `approved` and created `state.json` with the approval history event. The fix verified, but the test target now has an approved (partial, 3-sprint) plan instead of a draft. Users running similar smoke tests should target a throwaway goal directory or expect lifecycle advancement as a real side effect of the script working.

[1.1.10]: https://github.com/lokafinnsw/claude-code-goal-mode/releases/tag/v1.1.10

## [1.1.9] — 2026-05-10

### Fixed

- **`CLAUDE_PLUGIN_ROOT: unbound variable` crash in all 8 shim scripts when run from Claude Desktop.** Real failure case from the wild: user clicked `/goal-approve-plan` in Desktop, install.sh-deployed `~/.claude/commands/goal-approve-plan.md` invoked `/Users/.../scripts/approve-plan.sh`, the shim said `node "${CLAUDE_PLUGIN_ROOT}/engine/approve-plan-cli.mjs"` and crashed. Root cause: Claude Code CLI's plugin loader sets `CLAUDE_PLUGIN_ROOT` env var when invoking plugin commands; Claude Desktop has no plugin loader so the env var is unset; the script's `set -u` then explodes. Fix: each of the 8 shims (`abandon-goal.sh`, `approve-plan.sh`, `approve.sh`, `clear-goal.sh`, `pause-goal.sh`, `resume-goal.sh`, `start-goal.sh`, `status-goal.sh`) and the `hooks/stop-hook.sh` now have a defensive default that derives `CLAUDE_PLUGIN_ROOT` from `BASH_SOURCE` if the env var is unset: `: "${CLAUDE_PLUGIN_ROOT:=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"`. CLI mode: env var stays as set by loader, default ignored. Desktop mode: derives from script's own location (always `<plugin-root>/scripts/X.sh` so `dirname/..` resolves to plugin-root). Verified: all 8 shims now succeed (showing functional "no active goal" messages) when invoked without `CLAUDE_PLUGIN_ROOT`. (`scripts/*.sh`, `hooks/stop-hook.sh`)

- **`/goal:X` slash-command syntax was wrong everywhere; should be `/goal-X`.** Real failure case from the wild: agent (running per `prompts/budget-limit.md`, `prompts/final-summary.md`, etc.) suggested user run `/goal:start --max-iter 200 --token-budget 2500000`. Both Claude Desktop and Claude Code CLI rejected this with "Unknown command: /goal-start. Did you mean /goal-start?" — the colon syntax does not exist as a user-facing slash command in either environment; commands are accessed by the `.md` filename (`commands/goal-X.md` → `/goal-X`). Fix: bulk replace `/goal:X` → `/goal-X` across all user-facing content (`prompts/`, `commands/`, `README.md`, `docs/`). 155 references migrated. CHANGELOG kept verbatim for historical accuracy. (`prompts/*.md`, `commands/*.md`, `README.md`, `docs/*.md`, snapshot test files updated)

### Notes

The two bugs were independent but both surfaced in the same Desktop test run. v1.1.5-1.1.8 only tested the Claude Code CLI install path; the Desktop install.sh path was untested end-to-end. The user explicitly requested smoke testing in v1.1.8, then ran one against Desktop and exposed both bugs at once. The lesson: every release should smoke both Path A (CLI plugin install) and Path B (install.sh + Claude Desktop) before shipping.

[1.1.9]: https://github.com/lokafinnsw/claude-code-goal-mode/releases/tag/v1.1.9

## [1.1.8] — 2026-05-10

### Added

- **`docs/SMOKE-TEST-PLAN-FROM-FILE.md`** — manual smoke-test recipe for `/goal:plan-from-file` against an edge-case plan. Covers: pick a 1000+ line plan, update plugin to version under test, run conversion, watch for forbidden phrases (full list with v1.1.4 → v1.1.5 → v1.1.6 → v1.1.7 regression history), verify all three files exist + are valid + are non-placeholder, run `/goal:approve-plan` as the structural check, spot-check fidelity by sampling 5 tasks against the source plan. Includes a reference smoke run executed against the user's 1394-line, 9-sprint Mancelot MVP plan (Sprint 0 fully, Sprint 1 fully, Sprint 2 partial; tree.json 297 lines, plan.md 305 lines, state.json 17 lines, both JSONs valid). The unit tests at `tests/continuation.test.mjs` catch prompt-regression at the string level; this recipe catches behavioral regression at the runtime level. (`docs/SMOKE-TEST-PLAN-FROM-FILE.md`)

### Notes

The smoke recipe was added in response to user feedback after a real failure case. Even with v1.1.7's hard mandates, the user's local plugin cache was still running v1.1.4 - the agent showed v1.1.4-era behavior because the version had not been pulled. This recipe makes it explicit that step 2 of the smoke is "update the plugin first", and step 4 is "watch for these specific forbidden phrases", so a reviewer running the smoke catches "your local cache is stale" before blaming the prompt. It also documents the maintainer's reference run as a comparison anchor.

[1.1.8]: https://github.com/lokafinnsw/claude-code-goal-mode/releases/tag/v1.1.8

## [1.1.7] — 2026-05-10

### Fixed

- **`/goal:plan-from-file` agent skipped two of three required output files and split `tree.json` across multi-turn Edit chains.** Real failure case from the wild on a 1394-line, 9-sprint plan: agent wrote only `.claude/goals/active/tree.json` (84KB, well-formed Sprint 0 + Sprint 1, ~44 + ~50 tasks each). It did NOT write `.claude/goals/active/plan.md` or `.claude/goals/active/state.json` (both required by the spec). It also said "Sprint 0 written, now adding Sprint 1 via Edit. I'll continue adding sprints across multiple Edit calls" — picking the slow iterative path when ONE Write per file would have completed the conversion. After the run, `/goal:approve-plan` would have failed (incomplete state, missing files). Fix: `prompts/plan-from-file.md` Hard Rule #2 now mandates ALL THREE files in this single turn (one Write per file, three Writes total, no Edit chains), bans the new specific hedging phrases ("I'll continue adding sprints across multiple Edit calls", "Sprint 0 written, now adding Sprint 1 via Edit"), and clarifies the multi-turn fallback: only declare context exhaustion explicitly, never silently leave the file in a state where `/goal:approve-plan` would fail. (`prompts/plan-from-file.md`, `tests/__snapshots__/continuation.test.mjs.snap`)

### Added

- **5 prompt-content smoke assertions in `tests/continuation.test.mjs`** so a future weakening edit fails LOUD instead of degrading silently. Asserts the prompt mandates all three files, forbids generator scripts, forbids multi-turn Edit chains and exact hedging strings ("this is a large Write but doable", "I'll continue adding sprints across multiple Edit calls", "Sprint 0 written, now adding Sprint 1 via Edit"), mandates "ONE Write per file / Three Writes total", and forbids leaving the file in a state where approve-plan fails. Test count: 283 → 288. (`tests/continuation.test.mjs`)

### Notes

This is a behavioral mandate test, not just a green CI signal. It was added in response to user feedback: "не просто прогнать, что тесты зеленые, а нормальную проверку — smoke! чтобы отловить все косяки!" The smoke covers: regression on the prompt's behavioral contract.

[1.1.7]: https://github.com/lokafinnsw/claude-code-goal-mode/releases/tag/v1.1.7

## [1.1.6] — 2026-05-10

### Added

- **`scripts/fix-cli-source.sh`** — auto-detect-and-migrate script for the `"source": "git"` bug in Claude Code 2.1.121-2.1.138's plugin marketplace registry. Scans `~/.claude/settings.json` (`extraKnownMarketplaces.goal-mode.source`) and `~/.claude/plugins/known_marketplaces.json` (`goal-mode.source`); if either has `"source": "git"`, replaces with `{"source": "github", "repo": "lokafinnsw/claude-code-goal-mode"}` and timestamps a backup. Idempotent: re-running on already-migrated files prints "OK ... no change". Touches only the goal-mode entry; other marketplaces preserved. (`scripts/fix-cli-source.sh`)
- **README troubleshooting one-liner**: `bash <(curl -sL https://raw.githubusercontent.com/lokafinnsw/claude-code-goal-mode/main/scripts/fix-cli-source.sh)` for users hit by the bug who haven't cloned the repo. (`README.md`)

### Fixed

- **`prompts/plan-from-file.md` Hard Rule #2 strengthened with explicit forbidden phrases.** Real failure case from the wild: after the 1.1.4 anti-generator-script fix, the agent stopped writing generators but still hedged ("I'll write tree.json directly. Given the scale (~470 tasks), this is a large Write but doable."). The user reads "doable" as "the agent isn't sure". Fix: prompt now lists forbidden hedging phrases by exact wording ("this is a large Write but doable", "let me write a generator", "given the scale...", "I'll start with a few tasks and continue", "this might take multiple turns") and mandates: "Just emit the Write calls." Also clarifies multi-turn fallback (Edit to extend, never replace tasks with TBD placeholders). (`prompts/plan-from-file.md`, `tests/__snapshots__/continuation.test.mjs.snap`)

### Notes

The `git`-vs-`github`-source-type mismatch is a Claude Code CLI bug. README troubleshooting documented the manual fix in 1.1.3, but a manual edit is friction. v1.1.6 ships an auto-fix script. Once Anthropic patches the validator/installer mismatch upstream, this script can be deprecated.

[1.1.6]: https://github.com/lokafinnsw/claude-code-goal-mode/releases/tag/v1.1.6

## [1.1.5] — 2026-05-10

### Fixed

- **`install.sh` jq filter triplicated existing Stop hooks.** Real failure case from a fresh install: user had one Stop entry containing 3 unrelated hooks (cmux-notify, landing-the-plane, audit-on-completion). After running install.sh, settings.json had FOUR Stop entries — the original got triplicated and the goal-mode entry was appended. Reason: the filter `(.hooks // [])[]?.command | contains("goal-mode") | not` produces ONE boolean PER hook in the entry (because `[]?` iterates the inner hooks array), and `select(...)` then passes the entry through ONCE PER boolean. With 3 unrelated hooks, the entry passed through `select` 3 times. Fix: collapse the multi-value stream into a single boolean via `((.hooks // []) | map(.command // "" | contains("goal-mode")) | any) | not`. Verified: idempotent across N runs, edge cases pass (empty Stop array, missing hooks key, existing goal-mode entry replaced regardless of `CLAUDE_PLUGIN_ROOT` path). Inline comment in install.sh documents why the naive form is wrong. (`install.sh`)

### Recovery for users hit by the bug in 1.1.0–1.1.4

If you ran `bash install.sh` from one of those versions and your `~/.claude/settings.json` now has multiple identical Stop entries:

```bash
# Inspect:
jq '.hooks.Stop | length' ~/.claude/settings.json   # >1 with same hooks = corrupted

# Restore from the timestamped backup install.sh created on first install:
ls -1t ~/.claude/settings.json.bak-* | head -1   # most-recent pre-install state
# Inspect that backup, then if it looks correct:
cp <backup-path> ~/.claude/settings.json

# Re-run install.sh from this 1.1.5+ release:
bash install.sh
```

[1.1.5]: https://github.com/lokafinnsw/claude-code-goal-mode/releases/tag/v1.1.5

## [1.1.4] — 2026-05-10

### Added

- **README "Usage" section** between Installation and Status. End-to-end recipes for both entry paths (`/goal:plan` from scratch, `/goal:plan-from-file` from existing Markdown), then "while pursuing" (`/goal:status`, `/goal:pause`, `/goal:resume`), review gates with manual override, stopping (`/goal:abandon`, `/goal:clear`), state-file map, and a tag reference for the engine's parser. Emphasizes the structural-defense semantic: engine refuses to advance unless every acceptance criterion has at least one mapped `<evidence>` tag. (`README.md`)

### Fixed

- **`/goal:plan-from-file` agent shortcut: writing a generator script instead of emitting `tree.json` + `plan.md` directly.** Real failure case from the wild: agent saw a 1394-line, 17-sprint, 61-task source plan and decided "I'll write a Node generator script to produce the schema, this keeps my output token usage tractable." The script approach loses fidelity (every node becomes templated, not faithful to the source's hand-authored nuance per section). Fix: `prompts/plan-from-file.md` now has an explicit Hard Rule #2 forbidding generator scripts and naming the cure: emit the schema directly via the Write tool, even if the result is 100KB+; large outputs are the cost of the task, not a reason to shortcut. Rule #1 also strengthened: read every line / heading / table / callout, page through 2000+ line files. (`prompts/plan-from-file.md`, `tests/__snapshots__/continuation.test.mjs.snap`)

### Notes

The "writes a generator script" anti-pattern is a real cost-optimization failure mode for any LLM-driven schema-conversion task where the source is large. Documenting the anti-pattern in the prompt itself (as a Hard Rule, not a hint) is the cure.

[1.1.4]: https://github.com/lokafinnsw/claude-code-goal-mode/releases/tag/v1.1.4

## [1.1.3] — 2026-05-10

### Fixed

- **`marketplace.json` plugin source switched from `url` (with sha pin) to `url` (no sha)**. The pinned-sha form locked installs to the v1.1.2 commit forever, so users could never receive `/plugin marketplace update` improvements. Dropping the sha lets the plugin loader pull the latest `main` on every marketplace update — at the cost of pinning, gained "this is the same workflow `claude-plugins-official` plugins use." (`marketplace.json`)

### Documentation

- **README "Installation" rewrite**. Explicit Path A (CLI) vs Path B (Desktop) sections, with a "pick one — don't run both" warning (running both registers the Stop hook twice and the engine double-mutates state). Added "Switching between paths" with the two cleanup recipes. (`README.md`)
- **README "Troubleshooting" section added**. Documents the `git` vs `github` source-type pitfall in `~/.claude/settings.json` → `extraKnownMarketplaces`: when a user runs `/plugin marketplace add <https-URL-with-.git-suffix>`, some Claude Code 2.1.x versions store the marketplace as `"source": "git"`, which the installer rejects with "source type not supported" even though `marketplace add` accepts it. The fix is a manual edit to `"source": "github"` + `"repo"`. Also documents the unrelated-hook-error noise users may see (e.g. `claude-mem` `zod/v3` missing) and how to silence it. (`README.md`)

### Notes

The `git`-vs-`github`-source mismatch is a real bug in Claude Code 2.1.121–2.1.138 — the marketplace-add validator accepts `["github","git","url","settings"]` but the install switch only handles `["npm","github","url","git-subdir"]`. Reported via in-CLI testing on 2026-05-10.

[1.1.3]: https://github.com/lokafinnsw/claude-code-goal-mode/releases/tag/v1.1.3

## [1.1.2] — 2026-05-10

### Fixed

- **`/plugin install goal-mode@goal-mode` failed with "This plugin uses a source type your Claude Code version does not support"**. Root cause: `marketplace.json` had `"source": "."` — a self-referential string source that the May 2026 Claude Code marketplace schema does not accept. Per the official schema (https://code.claude.com/docs/en/plugin-marketplaces), valid sources are either a relative subdirectory string (`"./plugins/foo"`) OR an object like `{"source": "github", "repo": "owner/repo"}`. Fix: switched to GitHub source. The plugin loader now clones from https://github.com/lokafinnsw/claude-code-goal-mode at install time. (`marketplace.json`)

- **Vendored `node_modules/zod`** to make the plugin self-contained. Claude Code does not run `npm install` when cloning a plugin into `~/.claude/plugins/cache/`, but `engine/state.mjs` imports `zod` at runtime — so without vendoring the engine would crash on first Stop hook invocation with `Cannot find module 'zod'`. Other deps (vitest, etc.) remain `.gitignore`'d as they're devDependencies. Adds ~5 MB / 596 files to the repo, but eliminates a class of post-install failures and makes `/plugin install` work cleanly. (`.gitignore`, `node_modules/zod/`)

### Notes

This release un-breaks the Claude Code CLI install path that 1.0.0–1.1.1 had silently broken (the marketplace schema required objects-or-subdirs since some earlier Claude Code release). Existing users who installed via `install.sh` (Claude Desktop path) are unaffected.

To re-install after this fix:

```
/plugin marketplace update goal-mode  # if you previously added it
# or, fresh:
/plugin marketplace add https://github.com/lokafinnsw/claude-code-goal-mode
/plugin install goal-mode@goal-mode
```

[1.1.2]: https://github.com/lokafinnsw/claude-code-goal-mode/releases/tag/v1.1.2

## [1.1.1] — 2026-05-10

### Added

- **`install.sh`** — idempotent installer for Claude Desktop and any environment where `/plugin install` is unavailable. Reads the repo path, copies `commands/goal-*.md` to `~/.claude/commands/` with `${CLAUDE_PLUGIN_ROOT}` substituted to absolute paths, registers the Stop hook in `~/.claude/settings.json` with `CLAUDE_PLUGIN_ROOT` env injection, adds path-pinned Bash permissions for the repo's `scripts/*.sh` and `hooks/*.sh`. Backs up existing `settings.json` to `.bak-<ts>` on first run. Re-run after `git pull` to refresh commands. Preserves any existing non-goal-mode Stop hooks (idempotent `jq` filter on `goal-mode` substring in command).
- **README "Installation" section** — split into "Claude Code CLI" path (`/plugin install`) and "Claude Desktop / when `/plugin` isn't available" path (`bash install.sh`). Documents what `install.sh` does, where state lives, and uninstall.

### Why

`/plugin install goal-mode` only works in Claude Code CLI (terminal app). Claude Desktop and other Claude environments cannot use `/plugin marketplace add`, but they DO read `~/.claude/commands/` for slash commands and `~/.claude/settings.json` for hooks. `install.sh` makes goal-mode work in both worlds via the same user-global config Claude Desktop already honors.

[1.1.1]: https://github.com/lokafinnsw/claude-code-goal-mode/releases/tag/v1.1.1

## [1.1.0] — 2026-05-10

### Added

- **`/goal:plan-from-file <path>`** — new slash command for users who already have a Markdown plan written. The LLM reads the user's source file (any layout — H2/H3/H4 hierarchy, flat bullet lists, mixed conventions), maps it to the Sprint → Epic → Task schema, extracts acceptance criteria and validate commands from the source where present (synthesizes from task title/goal where absent — every task must have ≥1 criterion to satisfy the engine's schema), and writes `tree.json` + normalized `plan.md` + draft `state.json` into `.claude/goals/active/`. Composes cleanly with `/goal:approve-plan` → `/goal:start` (no engine changes — the existing `validatePlan` validates the converted tree, and the existing lifecycle gates accept it). (`commands/goal-plan-from-file.md`, `prompts/plan-from-file.md`)

### Changed

- **README + `/goal:help`**: 11 slash commands instead of 10 (added `/goal:plan-from-file`); refreshed Commands table with the new entry.
- **`docs/PLAN-FORMAT.md` + Commands table**: `/goal:plan <mission>` is now described as "build from scratch (LLM bootstrap)" to distinguish from `/goal:plan-from-file <path>` ("convert from existing Markdown").

### Notes

This is the natural complement to `/goal:plan`: `/goal:plan` asks the LLM to design the plan; `/goal:plan-from-file` asks the LLM to translate the user's pre-written plan into the engine's schema. The `validatePlan` business-rule layer (Phase 6) catches placeholder strings (`TBD`, `TODO`, etc.) the user's source may have left in — fix them between `/goal:plan-from-file` and `/goal:approve-plan`.

Test count post-1.1.0: 282 → 283 committed across 24 files (+1 snapshot test for `prompts/plan-from-file.md`).

[1.1.0]: https://github.com/lokafinnsw/claude-code-goal-mode/releases/tag/v1.1.0

## [1.0.1] — 2026-05-10

### Fixed

- **Bug A (Important)** — `/goal:start` after `/goal:approve-plan` now succeeds without `--force`. The Phase 5.1 hardening M-2 gate ("refuse double-startGoal without --force") was too aggressive — it refused even the canonical post-approval workflow, since `approvePlan` writes a `lifecycle="approved"` state to record the `plan-approved` history event. Fix limits M-2 refusal to non-restartable lifecycles (`pursuing`, `paused`, `achieved`, `unmet`, `budget-limited`); `draft` and `approved` now restart without `--force`. M-2 protection preserved for mid-flight and terminal states. (`engine/start-goal.mjs`)

- **Bug B (Minor latent)** — `safeFilenamePart` (twin in `engine/apply-mutations.mjs` and `engine/manual-approve.mjs`) now collapses runs of 2+ dots to `_`. Previously `..` survived sanitization because `.` was in the allowed character set for filename extensions. No exploit path existed in 1.0.0 (`node_id`/`agent` is always embedded in a larger token), but defense-in-depth against future code paths that may use the sanitized string as a path component.

### Discovered via

User-driven adversarial testing (`tests/adversarial-phases-5-8.test.mjs`, 80 hostile tests covering Phases 5-8 — local-only dev tracker, not in CI). 5 regression tests added to committed test files: 3 in `tests/start-goal.test.mjs` (Bug A acceptance + M-2 preservation), 1 each in `tests/apply-mutations.test.mjs` and `tests/manual-approve.test.mjs` (Bug B traversal-attempt sanitization).

Test count post-fix: 277 → 282 committed tests across 24 files.

[1.0.1]: https://github.com/lokafinnsw/claude-code-goal-mode/releases/tag/v1.0.1

## [1.0.0] — 2026-05-10

### Added

Initial stable release. The first complete plan-tree goal mode for Claude Code.

**Engine** (10 modules):
- `engine/state.mjs` — zod schemas for the plan-tree, runtime state, history events, and triple budget; atomic on-disk persistence with `.broken-<ts>-<seq>.json` corrupt-file forensic copies.
- `engine/paths.mjs` — path helpers for `.claude/goals/active/`, `.claude/goals/archive/`.
- `engine/traversal.mjs` — pre-order DFS over the plan-tree, leaf-task walker, cursor advancement.
- `engine/continuation.mjs` — pure Mustache-subset renderer with arbitrary nesting + `buildContext` for prompt rendering + `TemplateRenderError` typed error class.
- `engine/parse-tags.mjs` — pure parser for the documented tag set (`<evidence>`, `<task-status>`, `<review-request>`, `<audit-verdict>`, `<blocker>`).
- `engine/apply-mutations.mjs` — pure mutation engine: evidence accumulation → criteria-coverage check → cursor advance → review-pending lifecycle → 3-cycle blocked-escalation → terminal `achieved`/`unmet` lifecycle transitions; optional audit-verdict JSON persistence.
- `engine/transcript.mjs` — TOCTOU-safe JSONL session-transcript reader.
- `engine/stop-hook.mjs` — runtime orchestrator composing every prior module; lifecycle gates, code-region stripping before tag parsing, audit persistence, terminal-template rendering.
- `engine/budget.mjs` — `tallyTokens` from session JSONL + `checkLimits` triple-budget check.
- `engine/wallclock.mjs` — shared `wallclockMinutes` helper with NaN-clamp and injectable `now`.

Plus 8 CLI wrappers (`engine/*-cli.mjs`) for the slash commands (one wrapper covers `/goal:pause` + `/goal:resume`), all guarded by `import.meta.url ===` for testability.

**Prompts** (8 templates) in `prompts/`:
- `continuation.md` — pursuing-turn default.
- `continuation-review.md` — review-pending turn.
- `continuation-blocked.md` — blocked-task turn.
- `budget-limit.md` — graceful exit on budget exhaustion.
- `final-summary.md` — goal-achieved final turn.
- `unmet-summary.md` — goal-unmet terminal turn (deviation from plan; closes a UX gap).
- `audit-instructions.md` — body injected into reviewer `Agent()` calls.
- `plan-bootstrap.md` — instructs Claude to build the plan-tree on `/goal:plan`.

**Slash commands** (10) in `commands/` + `scripts/` shims:
- `/goal:plan <mission>` — bootstrap a plan-tree.
- `/goal:approve-plan` — validate + lock plan; lifecycle `draft → approved`.
- `/goal:start [--max-iter N] [--token-budget N] [--time-budget Nm|Nh] [--force]` — begin pursuing.
- `/goal:status` — render plan-tree, cursor, budget bars, last events; archive-discovery fallback when no active goal.
- `/goal:pause` / `/goal:resume` — halt / resume; resume refuses on budget exhaustion.
- `/goal:approve [--reason "..."]` — manual review override when subagent unavailable.
- `/goal:abandon --reason "..."` — terminal `unmet`; refuses on already-terminal lifecycles.
- `/goal:clear [--archive]` — remove active dir; optional unique-timestamp archive.
- `/goal:help` — comprehensive command list + mental model + lifecycle states + budget primer + state files + anti-patterns.

**Documentation** in `docs/`:
- `PLAN-FORMAT.md`, `REVIEW-AGENTS.md`, `BUDGET.md`, `ANTI-PATTERNS.md`, `SMOKE-TEST.md`.
- `EXAMPLES/` — three sample plans (Python migration, Node JWT auth, JS refactor) with corresponding tree.json files; all round-trip through `validatePlan`.

**Test suite**: 277 unit + integration + E2E tests across 24 files (verified via `npx vitest run --exclude 'tests/adversarial*.mjs'`). Per-phase E2E suites prove cross-module wiring (Phase 3 parser→mutator, Phase 4 multi-iteration state persistence, Phase 5 lifecycle journey, Phase 6 plan-flow, Phase 7 audit-gate, Phase 8 multi-turn budget, Phase 10 example-plan validation). CI green per commit.

### Notes

This release implements all 10 phases of the original design:
- Phases 0–4: foundation (skeleton, state, renderer, parser/mutator, Stop-hook orchestrator).
- Phases 5–7: user-facing surface (slash commands, plan bootstrap, audit gate).
- Phase 8: budget enforcement (tally + 3-axis exhaustion).
- Phase 9: discoverability (`/goal:help`, status archive-discovery).
- Phase 10: docs + examples + 1.0.0 tag.

Two design choices documented as known limitations (defer to post-1.0.0):
- `tallyTokens` excludes `cache_read_input_tokens` (under-counts billing on cache-heavy sessions; documented in `docs/BUDGET.md`).
- Archive *recovery* (`.broken-<ts>-<seq>.json` forensic-copy restore, archive→active copy-back) is discovery-only; no `/goal:restore` command yet.

[1.0.0]: https://github.com/lokafinnsw/claude-code-goal-mode/releases/tag/v1.0.0
