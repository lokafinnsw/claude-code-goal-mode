# Versioning matrix — goal-mode v1.x → v2.x

Source of truth for which ADR ships in which version, what breaks, and how to
migrate. Updated on every release.

## Released

| Version | Date | ADR(s) | Breaking? | Notes |
|---|---|---|---|---|
| 1.0.0 | 2026-05-10 | — | first stable | Initial Phase 1–10 work; mutable JSON + Stop hook driver. |
| 1.0.x | 2026-05-10 | — | no | Bug-fix patches against 1.0.0. |
| 1.1.0 → 1.1.17 | 2026-05-10 | — | no | Install path, marketplace registration, Desktop compat. |
| 1.1.18 | 2026-05-10 | — | no | Transcript-derived session_id (replaces wildcard workaround). |
| 1.1.19 → 1.1.22 | 2026-05-10 | — | no | Auto-rebind, anti-flap, error-as-prompt, two-layer continuation convention. |
| 1.2.0 | 2026-05-10 | — | no | Stability & UX SOTA pass: `/goal-doctor`, schema migrations, progress bar, SessionStart auto-resume, reviewer-independence enforcement, event-log dual-write architecture. |
| 1.2.1 | 2026-05-11 | — | no | Patch closing 10 v1.2.0 self-critique items: `goal-started` + `budget-tick` events for replay completeness, rejected verdicts visible in continuation-review, event-log + state.history rotation, pre-migration backup retention, semver dep, `doctor --fix`, `/goal-tree`, event-first atomic write order, install.sh e2e test. |
| 1.3.0 | 2026-05-11 | **ADR-0002** | no (additive) | File-based advisory lock (`engine/lock.mjs`) wired into all 7 write sites + Stop hook. Race-free read-decide-write across CLI + Stop hook concurrent invocations. |

## Planned

| Version | Target date | ADR(s) | Breaking? | Plan |
|---|---|---|---|---|
| 2.0.0-rc1 | 2026-05-?? | **ADR-0001** (dual-write phase) | no (additive) | Events.jsonl dual-written alongside `state.json` + `tree.json`. Reads still come from JSON. Mancelot dogfooding. |
| 2.0.0-rc2 | 2026-05-?? | ADR-0001 (reader switch) | yes (on-disk layout) | Reads route through reducer. `state.json` + `tree.json` become regenerable caches. `loadStateWithRecovery` becomes default load path. |
| 2.0.0 | 2026-05-?? | ADR-0001 (cleanup) | yes | Legacy dual-write code removed. Migration script `engine/migrate-v1-to-v2.mjs` for existing projects. |
| 2.1.0 | 2026-05-?? | **ADR-0003** | yes (file layout) | Multi-goal namespace. `.claude/goals/active/` → `.claude/goals/<goal-id>/`. `.active` pointer. New CLIs: `/goal-list`, `/goal-switch`, `/goal-fork`, `/goal-delete`, `/goal-create`, `/goal-detail`. |
| 2.2.0 | 2026-05-?? | **ADR-0004** | no (opt-in) | Plan-as-code TypeScript DSL. Monorepo split: `packages/engine`, `packages/schema`, `packages/plan-dsl`. `@goal-mode/schema` and `@goal-mode/plan-dsl` on npm. |

## Migration commands

| From → To | Command | Idempotent? | Backup created? |
|---|---|---|---|
| v1.0 → v1.2 | (none) | n/a | n/a |
| v1.x state with v1 schema_version → v2 | auto on load (`engine/migrations.mjs`) | yes | `state.json.pre-migration-v1-<ts>` (kept last 3 per v1.2.1 retention) |
| v1.x mutable JSON → v2.0.0 event log | `node engine/migrate-v1-to-v2.mjs` | yes | `state.json.pre-v2-migration-<ts>` (kept indefinitely) |
| v2.0.0 single-goal → v2.1.0 multi-goal | `node engine/migrate-v1-to-v2-layout.mjs` | yes | `archive/<date>-<slug>/` (existing v1 archives preserved as siblings) |

## Breaking changes summary per major

### v2.0.0 (ADR-0001)
- **On-disk:** `events.jsonl` becomes canonical. `state.json` + `tree.json` move to `derived/` and are regenerable.
- **Engine API:** `loadState(projectRoot)` returns derived snapshot; `saveState` becomes private (every save goes through event append).
- **Lifecycle commands:** internally emit events instead of mutating state directly. External CLI surface unchanged.
- **Plugin install:** no change. The migration runs on first load.

### v2.1.0 (ADR-0003)
- **On-disk:** `.claude/goals/active/` → `.claude/goals/<goal-id>/`. `.active` pointer text file.
- **Engine API:** `paths.mjs` helpers grow mandatory `goal_id` parameter.
- **CLI commands:** existing commands accept `--goal-id` override. Six new commands added.

### v2.2.0 (ADR-0004)
- **No breaking changes for engine consumers** — DSL is opt-in authoring layer.
- **Repo layout:** `engine/*.mjs` moves to `packages/engine/src/*.ts` (or stays .mjs in `packages/engine/src/`). External imports preserved via compatibility shims.
- **npm packages:** `@goal-mode/schema`, `@goal-mode/plan-dsl` published as separate npm packages.

## Rollback policy

Each release ships with the previous version's artifact preserved. Concrete rollback paths:

| From | To | How |
|---|---|---|
| v1.3.x → v1.2.1 | downgrade | `git checkout v1.2.1 && bash install.sh`. Lock files (`.lock`) left in place will be ignored by v1.2.1 (it doesn't acquire). Manually delete with `rm .claude/goals/active/.lock` if desired. |
| v2.0.0-rc1 → v1.3.0 | downgrade | `git checkout v1.3.0 && bash install.sh`. Events.jsonl is preserved on disk but ignored by v1.3.0 (which only reads tree.json + state.json). No data loss because dual-write kept JSON canonical. |
| v2.0.0-rc2 / v2.0.0 → v1.x | NOT SUPPORTED | Reader switch + cleanup removes legacy JSON write path. To downgrade, the user must run the v1 reverse-migration: `node engine/migrate-v2-to-v1.mjs` (planned to ship with v2.0.0 RC2 for forensic / emergency use only). |
| v2.1.0 → v2.0.x | downgrade | `git checkout v2.0.x && bash install.sh`. The multi-goal namespace layout (`<goal-id>/` subdirs) is incompatible with v2.0.x; reverse-migration script `engine/migrate-v2.1-to-v2.0-layout.mjs` consolidates to `active/` (using `.active`-pointed goal). |
| v2.2.0 → v2.1.x | downgrade | Same: `git checkout`. DSL is opt-in; plan.ts authors lose typechecking but tree.json from compiled output is still valid v2.1.x format. |

## Reference

- [ADR-0001](adr/0001-event-log-source-of-truth.md) — event log as source of truth
- [ADR-0002](adr/0002-concurrent-session-locking.md) — file-based advisory lock
- [ADR-0003](adr/0003-multi-goal-namespace.md) — multi-goal namespace
- [ADR-0004](adr/0004-plan-as-code-typescript-dsl.md) — plan-as-code TypeScript DSL
- [Acceptance gates](acceptance-gates.md) — explicit ship criteria per ADR
- [CHANGELOG.md](../../CHANGELOG.md) — release notes
