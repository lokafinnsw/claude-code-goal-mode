# Changelog

All notable changes to claude-code-goal-mode are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
