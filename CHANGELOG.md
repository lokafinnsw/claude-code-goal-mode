# Changelog

All notable changes to claude-code-goal-mode are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
