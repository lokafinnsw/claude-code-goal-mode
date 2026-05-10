<h1 align="center">claude-code-goal-mode</h1>

<p align="center">
  <strong>A <code>/goal</code> command for Claude Code.</strong>
  <br>
  Long-horizon autonomous mode driven by a hierarchical plan-tree, evidence-mapped acceptance criteria, declarative review-gates, and a triple budget.
</p>

<p align="center">
  <a href="https://github.com/lokafinnsw/claude-code-goal-mode/actions/workflows/ci.yml"><img src="https://github.com/lokafinnsw/claude-code-goal-mode/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License"></a>
  <a href="#status"><img src="https://img.shields.io/github/v/tag/lokafinnsw/claude-code-goal-mode?label=release&color=brightgreen" alt="Latest release"></a>
</p>

---

## TL;DR

OpenAI shipped Codex `/goal` in CLI 0.128.0 — set a verifiable objective and the agent works for hours toward it, plan→act→test→review→iterate, until an audit confirms the goal is met or a token budget is exhausted. **goal-mode brings the same UX to Claude Code, with a richer model: the goal is a tree of tasks, every task has explicit acceptance criteria, and visual or quality-critical tasks gate on independent review verdicts before the cursor advances.**

```bash
# After installing:
/goal-plan "Migrate auth from sessions to JWT, with tests and zero downtime"
/goal-approve-plan
/goal-start --max-iter 200 --token-budget 5000000 --time-budget 8h
# Walk away. Come back to a finished feature, not a half-baked guess.
```

## Why goal-mode

Coding agents stop after one turn. For multi-hour work — migrations, refactors, feature builds — that means constant baby-sitting: re-prompt, re-orient, re-verify after every iteration. `/goal` removes the user from the loop without removing the safety rails.

Anthropic ships [Ralph Loop](https://github.com/anthropics/claude-plugins-official/tree/main/plugins/ralph-loop) — the closest existing analog in Claude Code. Ralph solves the **continuation primitive**: a Stop hook intercepts session exit and re-feeds the prompt until a `<promise>X</promise>` tag is emitted. goal-mode borrows that primitive and layers a real plan-execution model on top.

| Capability | Ralph Loop | goal-mode |
|---|:---:|:---:|
| Stop-hook continuation in same session | ✅ | ✅ |
| Plan structure | flat prompt | hierarchical Sprint → Epic → Task |
| Acceptance criteria per task | ❌ | ✅ (zod-validated, evidence-mapped) |
| Review gates | ❌ | ✅ (declarative, project-specific) |
| Budget control | iterations only | iterations + tokens + wall-clock |
| Lifecycle states | active / cancelled | seven-state lifecycle with terminal `achieved`, `unmet`, `budget-limited` |
| Continuation prompt | static every iteration | re-rendered from disk state every iteration |
| Anti "proxy-signal collapse" | ❌ | ✅ (engine refuses `achieved` until every criterion has evidence) |
| Survives `/clear` and compactions | partial | full (state on disk, re-read every turn) |
| Cross-session reattach | ❌ | ✅ |
| Manual review override | ❌ | ✅ |

Ralph Loop is great for one-prompt-replay tasks ("keep trying this until tests pass"). goal-mode is for **multi-task missions where you want to walk away for hours and come back to a coherent finished feature.**

## How it works

A 1-line bash Stop-hook shim invokes a Node ESM engine. The engine owns all state mutation and prompt rendering; Claude does the actual code work.

```
.claude/goals/active/
├── plan.md            ← Human-readable plan-tree, single source of truth for review
├── tree.json          ← Same plan as data, zod-validated
├── state.json         ← Lifecycle, cursor (current task), triple budget, history
├── notes.md           ← Append-only digest of every iteration's progress
└── audits/            ← One JSON file per review verdict from a review-agent
    └── <node-id>-<iso-ts>-<agent>.json
```

Each Stop turn the engine:

1. Reads `tree.json` and `state.json` from disk.
2. Parses the agent's last message for structured tags: `<evidence file="…" criterion="…">`, `<task-status>`, `<review-request agents="…"/>`, `<audit-verdict status="GO|NOGO|REVISE">`, `<blocker>`.
3. Applies mutations: appends evidence, advances the cursor on completion, increments review attempts on NOGO verdicts, transitions lifecycle on terminal events.
4. Tallies tokens from the session JSONL, checks all three budgets, may transition to `budget-limited`.
5. Renders a fresh continuation prompt for the next turn (template + current state) and emits `{ "decision": "block", "reason": <rendered>, "systemMessage": ... }` so Claude continues without user input.
6. Saves state atomically (`.tmp` + `rename`).

The agent never edits state files directly — it emits tags, the engine interprets them. Three implications:

- **Compaction and `/clear` are non-events.** Every turn re-reads from disk. The agent's prior reasoning isn't load-bearing.
- **The engine refuses to advance** until every acceptance criterion has at least one mapped `<evidence>` tag. Even if the agent claims `<task-status>achieved</task-status>`, the cursor stays put unless the criteria-coverage check passes. This is the structural defense against "proxy-signal collapse" — the failure mode where the agent declares success because tests pass, even though the actual user objective wasn't met.
- **Review gates are declarative.** A task with `review: ["aaa-art-director", "rpg-game-designer"]` puts the task into `review-pending` state and instructs Claude to call `Agent({ subagent_type: "..." })` for each, collect verdicts, and only advance on all-GO.

## Stack-agnostic by design

The engine has zero hardcoded knowledge of which test framework, language, build tool, or review-agent name is in use. All such names are opaque strings declared in `tree.json` by the `/goal-plan` bootstrap phase, which surveys the project to decide what makes sense.

| Project type | `validate` example | `review` example |
|---|---|---|
| Rust backend | `cargo test --package auth` | `["rust-security-reviewer"]` |
| Python ML | `pytest tests/test_migration.py -x` | `["ml-reviewer", "dataops-reviewer"]` |
| Go service | `go test ./internal/auth/...` | `["api-contract-reviewer"]` |
| TypeScript SPA | `npm test -- src/auth && npm run typecheck` | `["frontend-a11y-reviewer"]` |
| Game (Phaser/Unity/UE) | `npm run build && npm test -- src/canon` | `["aaa-art-director", "rpg-game-designer"]` |
| C# Unity | `dotnet test Tests.csproj --filter AuthTests` | `["ux-reviewer"]` |

The engine sees opaque strings and dispatches them. Adding goal-mode to a Rust, Go, C++, C#, Python, or game-engine project requires zero engine-side changes. Project-specific reviewers come from the user's own `~/.claude/skills/` and `~/.claude/agents/` — goal-mode does not bundle reviewers.

## Commands

| Command | Purpose |
|---|---|
| `/goal-plan <mission>` | Survey the project, build a Sprint → Epic → Task plan-tree from scratch (LLM bootstrap) with stack-appropriate `validate` commands and project-specific review agents. Lifecycle → `draft`. |
| `/goal-plan-from-file <path>` | Convert an existing Markdown plan file into the goal-mode schema. Use when you already have a plan in Markdown (any layout). LLM parses your file, normalizes to Sprint → Epic → Task, extracts acceptance criteria + validate commands, writes `tree.json` + normalized `plan.md` + draft `state.json`. Lifecycle → `draft`. |
| `/goal-approve-plan` | Validate the plan (schema, criteria coverage, placeholder scan). Lifecycle → `approved`. |
| `/goal-start [--max-iter N] [--token-budget N] [--time-budget Nm\|Nh]` | Begin pursuing. Stop hook becomes active. |
| `/goal-status` (or just `/goal`) | Render the plan-tree with status icons, cursor highlight, triple-budget bars, last events. |
| `/goal-pause` / `/goal-resume` | Halt or resume the loop. Resume refuses if any budget is exhausted. |
| `/goal-approve [--reason "..."]` | Manually issue a GO verdict for a `review-pending` task (when no suitable subagent is available). |
| `/goal-abandon --reason "..."` | Lifecycle → `unmet` with a recorded reason. |
| `/goal-clear [--archive]` | Remove the active goal (with optional snapshot to `.claude/goals/archive/<date>-<slug>/`). |
| `/goal-help` | Show all commands and the mental model. |

## Documentation

| Doc | Topic |
|---|---|
| [docs/PLAN-FORMAT.md](docs/PLAN-FORMAT.md) | `tree.json` schema field-by-field + `plan.md` Markdown convention + round-trip rules. |
| [docs/REVIEW-AGENTS.md](docs/REVIEW-AGENTS.md) | How to declare project-specific reviewers + multi-stack examples (Phaser/JS, Rust, Python ML). |
| [docs/BUDGET.md](docs/BUDGET.md) | Triple-budget mechanics, token tally semantics, recommended ranges per goal size, graceful exit. |
| [docs/ANTI-PATTERNS.md](docs/ANTI-PATTERNS.md) | Catalog of 10 failure modes (proxy-signal collapse, false promises, NOGO oscillation, etc.) + how Goal Mode defends against each. |
| [docs/SMOKE-TEST.md](docs/SMOKE-TEST.md) | Manual UX verification recipe for the full lifecycle inside a real Claude Code session. |
| [docs/EXAMPLES/](docs/EXAMPLES/) | Three sample plans: Python migration (pydantic v1→v2), Node feature (JWT auth), JS refactor (axios→fetch). Each plan.md + tree.json pair validates against the engine's schema + business rules. |

## Installation

Pick **one** path. Don't run both — they register the Stop hook twice and the engine will double-mutate state.

### Path A — Claude Code CLI (terminal app)

```
/plugin marketplace add https://github.com/lokafinnsw/claude-code-goal-mode
/plugin install goal-mode@goal-mode
/reload-plugins
```

Verify: `/goal-help` should print the command list.

### Path B — Claude Desktop / any env without `/plugin`

`/plugin install` is CLI-only. Claude Desktop reads `~/.claude/commands/` and `~/.claude/settings.json` directly. The repo ships an `install.sh` that wires goal-mode into both:

```bash
git clone https://github.com/lokafinnsw/claude-code-goal-mode
cd claude-code-goal-mode
bash install.sh
```

What `install.sh` does (idempotent — re-run after `git pull`):
1. Runs `npm install` if `node_modules/zod` is missing (engine runtime dep).
2. Copies `commands/goal-*.md` → `~/.claude/commands/`, replacing `${CLAUDE_PLUGIN_ROOT}` with the repo's absolute path so slash commands resolve without a plugin loader.
3. Adds the Stop hook to `~/.claude/settings.json` (preserving existing hooks/permissions; backs up original to `settings.json.bak-<ts>`).
4. Adds path-pinned permissions for the repo's `scripts/*.sh` and `hooks/*.sh`.

After install, restart Claude Desktop, then `/goal-help` should show the command list.

### Switching between paths

If you previously used Path B and now want Path A: `rm ~/.claude/commands/goal-*.md` and delete the goal-mode Stop-hook entry from `~/.claude/settings.json` (or restore from a `.bak`). Then run Path A.

If you previously used Path A and now want Path B: `/plugin uninstall goal-mode@goal-mode`, then run Path B.

### Troubleshooting

**`/plugin install` fails with "This plugin uses a source type your Claude Code version does not support".**

Likely cause: when you ran `/plugin marketplace add <full-URL>`, your Claude Code version stored the marketplace under `"source": "git"` in `~/.claude/settings.json` → `extraKnownMarketplaces` and `~/.claude/plugins/known_marketplaces.json`. The install handler only accepts `github`, `url`, `git-subdir`, `npm`. `git` is a sibling format the validator accepts but the installer rejects (a known mismatch in the 2.1.121-2.1.138 line as of May 2026).

**One-liner fix** (auto-detects + migrates `git` to `github` in both files; idempotent; backs up originals):

```
bash <(curl -sL https://raw.githubusercontent.com/lokafinnsw/claude-code-goal-mode/main/scripts/fix-cli-source.sh)
```

Then `/reload-plugins` (or restart Claude Code) and retry `/plugin install goal-mode@goal-mode`.

**Manual fix** (if you cloned the repo): `bash scripts/fix-cli-source.sh` from the repo root.

**Manual edit** (no curl/script): open `~/.claude/settings.json`, locate `extraKnownMarketplaces.goal-mode.source`, and change it from:

```json
"source": {
  "source": "git",
  "url": "https://github.com/lokafinnsw/claude-code-goal-mode.git"
}
```

to:

```json
"source": {
  "source": "github",
  "repo": "lokafinnsw/claude-code-goal-mode"
}
```

Repeat in `~/.claude/plugins/known_marketplaces.json`. Save, reload, retry.

**Hook errors from other plugins (e.g. `Cannot find module 'zod/v3' from .../claude-mem/...`).**

Unrelated to goal-mode — they're failing hooks from a different plugin. They show up because hooks run on every prompt/Stop. To silence them, set the offending plugin to `false` in `~/.claude/settings.json` → `enabledPlugins` and `/reload-plugins`.

## Usage

This section walks through the typical end-to-end flow. For per-command details, see `/goal-help`.

### From scratch (you have a mission, no plan yet)

```
/goal-plan "Migrate auth from sessions to JWT, with tests and zero downtime"
```

The LLM surveys your project (stack, test runner, lint configs) and writes a Sprint > Epic > Task tree into `.claude/goals/active/`. Three files appear: `tree.json` (machine, zod-valid), `plan.md` (human-readable, normalized), `state.json` (lifecycle: draft).

Open `.claude/goals/active/plan.md`. Edit anything you want changed. Then:

```
/goal-approve-plan
```

This validates schema + per-task acceptance criteria + placeholder scan, and locks the plan (lifecycle: approved). Edit-and-retry is fine: validation errors print line-by-line, fix in `plan.md`, re-run.

```
/goal-start --max-iter 200 --token-budget 5000000 --time-budget 8h
```

Lifecycle goes to `pursuing`. The Stop hook becomes active. Walk away.

### From your existing Markdown plan

If you already wrote a plan in Markdown, do not redo it. Convert it:

```
/goal-plan-from-file docs/plans/2026-05-09-mvp-roadmap.md
```

The LLM reads your file end-to-end (every line, every heading, every table; it pages through if the file is over 2000 lines), maps headings to Sprint > Epic > Task (H1 mission, H2 sprint, H3 epic, H4 task is the default; any layout is mapped by depth), extracts acceptance criteria and validate commands where the file marks them, synthesizes them where it does not (every task needs at least one criterion), and writes the same three files. The LLM does NOT write a generator script for this (the prompt explicitly forbids that shortcut); it emits the schema directly via the Write tool, even if the result is 100KB+.

After conversion, open the normalized `plan.md`, fix any `TBD` / `TODO` / `FIXME` placeholders the source file had (the engine rejects those at approve time), then:

```
/goal-approve-plan
/goal-start [flags]
```

### While the goal is pursuing

```
/goal-status
```

Or just `/goal`. Renders the tree with status icons, cursor highlight, three budget bars (iterations / tokens / wall-clock), last 10 history events.

```
/goal-pause
```

Halts the loop. Stop hook stays registered but emits no continuation. Resume with `/goal-resume` (refuses if any budget is exhausted).

### Review gates

A task with `review: ["aaa-art-director", "rpg-game-designer"]` enters `review-pending` status when the agent emits `<task-status>achieved</task-status>` plus full evidence coverage. The agent must call `Agent({ subagent_type: "..." })` for each declared reviewer and emit their `<audit-verdict>` tags. Three NOGO verdicts in a row escalate the task to `blocked`.

If a reviewer subagent does not exist locally:

```
/goal-approve --reason "manual GO: <evidence>"
```

Issues a manual GO verdict for the current `review-pending` task.

### Stopping

```
/goal-abandon --reason "scope changed"
```

Lifecycle goes to `unmet`. The reason is recorded in history.

```
/goal-clear --archive
```

Snapshots the current goal to `.claude/goals/archive/<date>-<slug>/` and removes the active dir. Without `--archive`, deletes outright.

### State files

The engine writes to `.claude/goals/active/`:

| File | Purpose |
| :-- | :-- |
| `tree.json` | The plan as data. Read every turn. Never mutated after `/goal-approve-plan`. |
| `plan.md` | The plan as Markdown. Source of truth for human review. |
| `state.json` | Lifecycle, cursor, budget tally, history. Atomically rewritten every Stop. |
| `notes.md` | Append-only digest of every turn's progress. |
| `audits/<node-id>-<iso-ts>-<agent>.json` | One file per audit verdict. |

Compaction and `/clear` are non-events; the engine re-reads from disk every turn.

### Tags the agent emits (reference, not required reading)

You do not need to know these to use goal-mode. The continuation prompt steers the agent to emit them. For reference:

- `<evidence file="src/auth/jwt.ts" criterion="acceptance.tests-pass">All 14 tests green</evidence>`: maps work to one acceptance criterion.
- `<task-status>achieved</task-status>`: the agent claims the task is done.
- `<review-request agents="aaa-art-director, rpg-game-designer"/>`: the agent requests audit.
- `<audit-verdict status="GO|NOGO|REVISE" reason="..."/>`: a reviewer's verdict.
- `<blocker reason="..."/>`: escalates the current task to `blocked`.

The engine refuses to advance the cursor unless every acceptance criterion has at least one mapped `<evidence>` tag, even if `<task-status>achieved</task-status>` is present. This is the structural defense against proxy-signal collapse (the failure mode where the agent declares success because tests pass, even though the real user objective was not met).

## Status

**v1.0.0 — stable.** All foundational phases shipped:

- ✅ Zod schemas + atomic persistence (`engine/state.mjs`)
- ✅ Pure renderer + 8 prompt templates (`engine/continuation.mjs`, `prompts/`)
- ✅ Tag parser + mutation engine (`engine/parse-tags.mjs`, `engine/apply-mutations.mjs`)
- ✅ Stop-hook orchestrator wiring all of the above (`engine/stop-hook.mjs`)
- ✅ 11 slash commands shipped (`commands/`, `engine/*-cli.mjs`)
- ✅ Plan bootstrap + approve flow (`prompts/plan-bootstrap.md`, `engine/validate-plan.mjs`)
- ✅ Audit-gate + manual override (`engine/manual-approve.mjs`, audit JSON persistence)
- ✅ Triple budget enforced (`engine/budget.mjs`, `tallyTokens` from JSONL)
- ✅ 4 reference docs + 3 sample plans + smoke recipe

`main` is the integration branch and is kept green per commit. See the [Actions tab](https://github.com/lokafinnsw/claude-code-goal-mode/actions) for the latest CI run.

## Inspiration and prior art

- **[OpenAI Codex `/goal`](https://developers.openai.com/codex/use-cases/follow-goals)** — direct inspiration. Persistent goal object, plan→act→test→review→iterate loop, audit-gated termination, token-budget control.
- **[Anthropic Ralph Loop](https://github.com/anthropics/claude-plugins-official/tree/main/plugins/ralph-loop)** — closest existing analog in Claude Code. Solves the Stop-hook continuation primitive that goal-mode also relies on.
- **[Geoffrey Huntley — "Ralph is a bash loop"](https://ghuntley.com/ralph/)** — the original autonomous-loop pattern that both Codex `/goal` and Ralph Loop derive from.

## Contributing

Issues and PRs welcome. After cloning:

```bash
npm install
npm test            # runs vitest
npm run lint:sh     # runs shellcheck on hooks/ and scripts/
```

CI runs both on every push and pull request.

## License

[MIT](LICENSE) © claude-code-goal-mode contributors
