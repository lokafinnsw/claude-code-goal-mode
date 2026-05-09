<h1 align="center">claude-code-goal-mode</h1>

<p align="center">
  <strong>A <code>/goal</code> command for Claude Code.</strong>
  <br>
  Long-horizon autonomous mode driven by a hierarchical plan-tree, evidence-mapped acceptance criteria, declarative review-gates, and a triple budget.
</p>

<p align="center">
  <a href="https://github.com/lokafinnsw/claude-code-goal-mode/actions/workflows/ci.yml"><img src="https://github.com/lokafinnsw/claude-code-goal-mode/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License"></a>
  <a href="#status"><img src="https://img.shields.io/badge/status-under%20construction-orange.svg" alt="Status"></a>
</p>

---

## TL;DR

OpenAI shipped Codex `/goal` in CLI 0.128.0 — set a verifiable objective and the agent works for hours toward it, plan→act→test→review→iterate, until an audit confirms the goal is met or a token budget is exhausted. **goal-mode brings the same UX to Claude Code, with a richer model: the goal is a tree of tasks, every task has explicit acceptance criteria, and visual or quality-critical tasks gate on independent review verdicts before the cursor advances.**

```bash
# After installing:
/goal:plan "Migrate auth from sessions to JWT, with tests and zero downtime"
/goal:approve-plan
/goal:start --max-iter 200 --token-budget 5000000 --time-budget 8h
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

The engine has zero hardcoded knowledge of which test framework, language, build tool, or review-agent name is in use. All such names are opaque strings declared in `tree.json` by the `/goal:plan` bootstrap phase, which surveys the project to decide what makes sense.

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
| `/goal:plan <mission>` | Survey the project, build a Sprint → Epic → Task plan-tree with stack-appropriate `validate` commands and project-specific review agents. Lifecycle → `draft`. |
| `/goal:approve-plan` | Validate the plan (schema, criteria coverage, placeholder scan). Lifecycle → `approved`. |
| `/goal:start [--max-iter N] [--token-budget N] [--time-budget Nm\|Nh]` | Begin pursuing. Stop hook becomes active. |
| `/goal:status` (or just `/goal`) | Render the plan-tree with status icons, cursor highlight, triple-budget bars, last events. |
| `/goal:pause` / `/goal:resume` | Halt or resume the loop. Resume refuses if any budget is exhausted. |
| `/goal:approve [--reason "..."]` | Manually issue a GO verdict for a `review-pending` task (when no suitable subagent is available). |
| `/goal:abandon --reason "..."` | Lifecycle → `unmet` with a recorded reason. |
| `/goal:clear [--archive]` | Remove the active goal (with optional snapshot to `.claude/goals/archive/<date>-<slug>/`). |
| `/goal:help` | Show all commands and the mental model. |

## Installation

Once published to a marketplace:

```bash
# Inside Claude Code
/plugin marketplace add https://github.com/lokafinnsw/claude-code-goal-mode
/plugin install goal-mode
```

In the meantime, the repo can be cloned and used as a local plugin source for testing.

## Status

**Currently in early development.** Foundation is in: zod schemas for the plan-tree and runtime state, atomic on-disk persistence with corrupt-file recovery, pre-order DFS leaf walker, cursor advancement.

Next up: the continuation-prompt renderer and templates, the structured-tag parser, and the Stop-hook orchestrator that wires everything together. Plan bootstrap, audit gate, and triple-budget tracking follow.

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
