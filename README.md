<h1 align="center">Better Goal</h1>

<p align="center">
  <strong>A <code>/goal</code> command for Claude Code — better.</strong>
  <br>
  Long-horizon autonomous mode driven by a hierarchical plan-tree, evidence-mapped acceptance criteria, declarative review-gates, and a triple budget.
</p>

<p align="center">
  <sub>Repo identifier: <code>claude-code-goal-mode</code> · Plugin namespace: <code>goal-mode</code> · Slash prefix: <code>/goal-mode:*</code></sub>
</p>

<p align="center">
  <a href="https://github.com/lokafinnsw/claude-code-goal-mode/actions/workflows/ci.yml"><img src="https://github.com/lokafinnsw/claude-code-goal-mode/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License"></a>
  <a href="#status"><img src="https://img.shields.io/github/v/tag/lokafinnsw/claude-code-goal-mode?label=release&color=brightgreen" alt="Latest release"></a>
</p>

## What's new in v3.0

**v3.0 is a workflow addition, not a rewrite.** Every v2.x state file loads unchanged. The plan-tree schema, event log, reviewer-independence guard, triple budget, and lock protocol are preserved. v3 primarily **adds** explicit CLI verbs as an opt-in alternative to tag-emission, alongside the auto-drive Stop-hook.

What changed:

| Before (v2) | After (v3.0.4) |
|---|---|
| Stop-hook injects continuation prompt every turn on `lifecycle=pursuing` | Stop-hook still auto-drives by default (v3.0.4 restored this). Hint-only mode is opt-in via `stopHookDriver: false` config. |
| Agent emits XML tags in reply (`<evidence>`, `<task-status>`, ...) | Agent can emit tags OR call explicit slash commands (both work) |
| Cursor advances via tag parsing in Stop-hook | Cursor advances via tag parsing OR CLI verb (`achieve`, `submit-verdict`) |
| Driver and agent loop tightly coupled | Same loop by default; safety nets (auto-pause-on-silence, stale-review detector) prevent runaway spam |

**v3.0.4 default:** auto-drive (`stopHookDriver: true`). Install, plan, walk away, come back to a finished feature — the original product value. Opt out into hint-only mode (no auto-drive; you call CLI verbs yourself) via `.claude/goals/active/config.json` (per-project) or `~/.claude/plugins/goal-mode/config.json` (per-user):
```json
{ "schema_version": 1, "stopHookDriver": false }
```

### New slash commands

| Command | Purpose |
|---|---|
| `/goal-mode:goal-current` | Read-only cursor inspector |
| `/goal-mode:goal-evidence-add` | Write evidence to cursor task |
| `/goal-mode:goal-achieve` | Claim task achievement |
| `/goal-mode:goal-review-request` | Print reviewer dispatch template |
| `/goal-mode:goal-submit-verdict` | Record reviewer verdict (with independence enforcement) |
| `/goal-mode:goal-as-builtin` | Emit text for piping into Claude Code's built-in `/goal` |

Migration is automatic: existing v2 goals continue to work; the new default takes effect after `bash install.sh + restart Claude Desktop`. See [docs/MIGRATION-v2-to-v3.md](docs/MIGRATION-v2-to-v3.md) for full migration guide.

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
| Lifecycle states | active / cancelled | eight-state lifecycle (draft → approved → pursuing → paused / awaiting-manual-approval / achieved / unmet / budget-limited) |
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

## Lifecycle states

| State | Meaning | Entry trigger | Exit |
|---|---|---|---|
| `draft` | Plan exists but not validated | `/goal-plan` or `/goal-plan-from-file` | `/goal-approve-plan` |
| `approved` | Plan locked, no budgets yet | `/goal-approve-plan` | `/goal-start` |
| `pursuing` | Active work — Stop hook drives turns | `/goal-start` (or `/goal-resume`) | `/goal-pause`, achievement, block escalation, budget exhaustion, escape-hatch |
| `paused` | User explicitly halted; Stop hook returns null | `/goal-pause` | `/goal-resume` |
| `awaiting-manual-approval` | **v2.0.4** — escape-hatch from unavailable reviewer; Stop hook fully suppressed | Reviewer subagent unavailable + `<audit-verdict status="REVISE">unavailable; ...</audit-verdict>` emitted | `/goal-approve <task-id>` (→ pursuing) or `/goal-abandon` (→ unmet) |
| `achieved` | Every leaf task achieved; terminal | Cursor advances past last task with all-GO | `/goal-clear` to start fresh |
| `unmet` | 3 consecutive blocks/NOGOs OR `/goal-abandon`; terminal | 3-strike or manual abandon | `/goal-clear` to start fresh |
| `budget-limited` | Iter/tokens/wallclock cap hit; terminal | Any axis exhausted | `/goal-resume` with fresh budget OR `/goal-clear` |

## Skills for agents

The plugin ships two skill definitions that teach controller agents how to interact with the engine correctly. Claude Code's skill loader auto-discovers them; agents invoke them via the `Skill` tool.

| Skill | Use when |
|---|---|
| `using-goal-mode` | Active goal driving the conversation (any pursuing / paused / awaiting / blocked state); before running `/goal-plan`, `/goal-start`, `/goal-approve`, `/goal-resume`, `/goal-abandon`, `/goal-clear`. Covers tag emission discipline, escape-hatch protocol, lifecycle states, anti-patterns, multi-session isolation, recovery paths. |
| `goal-mode-tag-discipline` | Before emitting a complex verdict or evidence block. Exact regex/format details for `parse-tags.mjs`, code-fence stripping, escape-hatch regex (`/^\s*unavailable\b/i`), attribute quoting rules, what the parser silently drops. |

Both skills include the `<SUBAGENT-STOP>` clause — reviewer subagents skip them automatically (their job is to emit `<audit-verdict>` only, per `commands/goal-review.md`).

For the user-facing slash-command reference, see `/goal-mode:goal-help` (or `commands/goal-help.md`).

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

### Path B — `install.sh` for Desktop-only users (no terminal CLI)

`/plugin install`, `/plugin marketplace add`, and `/reload-plugins` are CLI-only slash commands. Their definitions in the embedded Claude Code binary are typed `local-jsx` (interactive panel) and explicitly rejected in non-interactive sessions with "isn't available in this environment. Run it from the Claude Code terminal instead." So in pure-Desktop environments without terminal `claude`, Path A is impossible.

`install.sh` covers that case. **Since v1.1.17 it deploys to the same plugin cache location as `/plugin install` (`~/.claude/plugins/cache/goal-mode/goal-mode/<ver>/`), registers the marketplace with `autoUpdate: true`, and enables the plugin in settings.json — producing byte-equivalent end state to Path A.** Slash commands appear as `/goal-mode:goal-X` in the picker; no duplicates, no double-firing hooks, no parallel "user-global" path.

```bash
git clone https://github.com/lokafinnsw/claude-code-goal-mode
cd claude-code-goal-mode
bash install.sh
```

After install, restart Claude Desktop. Plugin loader picks up the cached plugin on next session.

Re-run after `git pull` to refresh the cached version. To uninstall: `bash install.sh --uninstall`.

If you previously used `install.sh` from v1.1.16 or earlier (deployed to `~/.claude/commands/` and added a Stop hook to `settings.json`), clean up the legacy artifacts:

```bash
rm -f ~/.claude/commands/goal-*.md
jq '.hooks.Stop = [.hooks.Stop[] | select((.hooks // []) | map(.command // "" | (contains("goal-mode") or contains("claude-code-goal-mode"))) | any | not)]' ~/.claude/settings.json | sponge ~/.claude/settings.json
```

### Auto-update (no manual `/plugin marketplace update`)

To have Claude Code pull the latest goal-mode from GitHub at every session start, set `autoUpdate: true` for the goal-mode marketplace in `~/.claude/plugins/known_marketplaces.json`. Two ways:

```bash
# A. one-liner (uses jq):
jq '."goal-mode".autoUpdate = true' ~/.claude/plugins/known_marketplaces.json | sponge ~/.claude/plugins/known_marketplaces.json

# B. via the maintainer script (also fixes the "git" source bug if present):
bash <(curl -sL https://raw.githubusercontent.com/lokafinnsw/claude-code-goal-mode/main/scripts/fix-cli-source.sh)
```

After this, no need to run `/plugin marketplace update goal-mode` per release. Same default that ships with `thedotmack/claude-mem` and other auto-tracked third-party marketplaces.

### Claude Desktop & Claude Code CLI both work (since v1.1.15)

All 11 commands AND the autonomous Stop-hook continuation loop work in both environments. Two fixes shipped to make this true:

- **v1.1.13** — switched 6 argument-bearing commands from `$ARGUMENTS` shell expansion (CLI-only) to a natural-language pattern (works in both). The command markdown now instructs the agent to parse the user's typed args and dispatch the script via Bash. Same `/goal-start --max-iter 800` typed text works in either environment.
- **v1.1.18** — fixed the autonomous loop in Desktop properly. Real-world finding: Desktop's embedded Claude Code subprocess does not export `CLAUDE_CODE_SESSION_ID`; the session id rides as `--resume <uuid>` CLI arg. v1.1.15's wildcard fallback (`session_id="*"`) was a workaround; v1.1.18 derives the real UUID by scanning `~/.claude/projects/<encoded-cwd>/` for the most-recently-modified `.jsonl` file (its basename IS the active session UUID — same value Stop-hook stdin will deliver). Both CLI and Desktop write transcripts there, so this works identically in either environment. Strict session-id matching in stop-hook is preserved (no wildcard escape hatch needed) — multi-session isolation works in both Desktop and CLI. Stop-hook session-id mismatch now writes a stderr diagnostic instead of silently no-op-ing, so misconfiguration is visible.

So `/goal-start --max-iter 800 --token-budget 20000000 --time-budget 24h` and the autonomous continuation loop both work the same way in Desktop and in CLI.

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

### Tags the agent emits (reference)

You do not need to know these to use goal-mode — the continuation prompt steers the agent to emit them. For reference (exact semantics in the `goal-mode-tag-discipline` skill):

| Tag | Purpose | Notes |
|---|---|---|
| `<evidence file="path/to/file" line="N" criterion="i" note="..."/>` | Map work to acceptance criterion `i` (0-indexed integer) | Can be self-closed or paired (`<evidence ...>body</evidence>`). `criterion` MUST be integer in `[0, criteria.length)`. |
| `<task-status>achieved\|pursuing\|blocked</task-status>` | Agent's declaration of current cursor task status | Case-insensitive since v2.0.3 |
| `<review-request agents="reviewer-1,reviewer-2"/>` | Transition `pursuing → review-pending` when all criteria covered | Self-closed only; comma-separated agent list |
| `<audit-verdict agent="reviewer-x" status="GO\|NOGO\|REVISE">verdict body</audit-verdict>` | Relay a reviewer subagent's verdict | Status case-normalized to UPPERCASE. Requires matching `Agent(subagent_type=reviewer-x)` dispatch in same turn's transcript (v2.0.0 reviewer-independence check); otherwise rejected as fabricated. |
| `<blocker>reason text</blocker>` | Reason paired with `<task-status>blocked</task-status>` | Empty/whitespace-only body silently dropped |

**Escape-hatch verdict (v2.0.1 + v2.0.4):** when a reviewer's `subagent_type` is not registered in the Claude environment (no matching `~/.claude/agents/<name>.md`), emit:

```
<audit-verdict agent="reviewer-x" status="REVISE">unavailable; user must run /goal-approve</audit-verdict>
```

Exact format: `status="REVISE"` AND verdict body starts with `unavailable` (case-insensitive, optional leading whitespace; regex `/^\s*unavailable\b/i`). The engine recognizes this, marks the cursor `blocked`, AND transitions `lifecycle` to `awaiting-manual-approval` — Stop hook then renders the recovery prompt ONCE and suppresses all subsequent ticks until `/goal-approve <task-id>` or `/goal-abandon`. No 3-strike unmet from environmental cause.

**Structural defenses (engine refuses to advance):**
- No `<task-status>achieved</task-status>` is honored without `<evidence criterion="i"/>` for every criterion. Prevents proxy-signal collapse (claiming tests-pass when the user objective wasn't met).
- No `<audit-verdict>` is accepted without matching `Agent(subagent_type=...)` dispatch in the same turn. Prevents fabricated reviewer verdicts.
- Real engine tags inside ``` fenced ``` code blocks or `inline backticks` are stripped before parsing. Example tags in prose-rendered prompts are intentionally ignored — real tags must be in prose or inside `<details>` blocks.

## Status

**v3.0.5 — stable (raised auto-pause silenceThreshold from 5 to 20 for autonomous-run friendliness).** All foundational + v2-track work shipped. **v3.0.5** raises the auto-pause-on-silence default threshold from 5 → 20: controllers in autonomous production runs legitimately spend 5-10 turns in exploration phases (reading files, running tests, iterating) without emitting goal-mode tags. The 5-turn threshold (calibrated for the degenerate "controller refuses to engage" case) was triggering false-positive auto-pause on legitimate work. Auto-pause remains an early-warning safety net layered on top of the triple budget; users can override per-project / per-user. **v3.0.4** flips `stopHookDriver` default back to `true` — auto-drive (Stop-hook fires continuation on `pursuing`) is the out-of-the-box experience, matching the original product value: install, plan, walk away, come back. The v3 explicit CLI verbs (`evidence-add`, `achieve`, `submit-verdict`, `current`, `review-request`, `as-builtin`) remain fully supported and callable any time as opt-in tools. Hint-only mode (no auto-drive) is opt-in via `stopHookDriver: false`. **Auto-pause-on-silence (v2.0.6) prevents controller-not-engaging spam loops** — when N=20 (v3.0.5) consecutive Stop-hook turns produce zero goal-mode tags, lifecycle auto-transitions to `paused` with a recoverable reason. Token-bleed safety net. **v3.0.1** adds a stale-review-pending detector: cursors stuck in `review-pending` >15min with no verdict events auto-transition to `awaiting-manual-approval`, preventing expensive Stop-hook prompt re-rendering when the controller stalls after dispatching a heavy reviewer subagent. **v3.0.2** is a brand rename only — surface labels updated to **Better Goal**; package name, plugin namespace, slash command prefix, and skill directories are unchanged (no migration needed). **v3.0.3** closes a CLI deadlock — `evidence-add` and `achieve` now auto-promote `cursor.status` from `pending → pursuing` on first engagement (was previously only set by v2 driver-mode tag emission), making v3 CLI verbs callable after `goal-resume` or on cursors left from historical v2 advance paths.

### What's new in the 2.0.x line (summary)

The 2.0.x line landed event-sourcing as canonical truth, concurrent-session locking, a tight engineering audit closeout with regression tests for every finding, and escape-hatch hardening that closed UX dead-ends users hit in production.

**Event sourcing + locking (2.0.0):**
- 15-kind event taxonomy with ULID-sorted append-only `events.jsonl`
- Pure reducer (no `Date.now` / `Math.random` / `fs` / `process.env`) — lint-enforced
- Snapshots + tail replay for O(tail) load instead of O(genesis)
- Transactional turn batches (atomic event emission per Stop-hook fire)
- File-based advisory lock per-goal with PID liveness + stale detection
- v1→v2 migration with `.pre-v2-migration-*` backups
- All 7 G1 acceptance gates closed (determinism, migration, cold/warm replay perf, crash injection, reducer purity, self-meta)

**Cross-project isolation (2.0.2):**
- Hooks prefer Claude Code's `stdin.cwd` over `process.cwd()` — multi-tab Claude Desktop setups no longer leak one project's continuation into another's session

**SOTA hardening pass (2.0.3):**
- New shared `engine/hook-context.mjs` — single source of truth for hook enrichment, used by both Stop and SessionStart (previously SessionStart rendered review/blocked templates with undefined fields)
- Incremental transcript checkpoint (`engine/transcript-checkpoint.mjs`) — O(new-bytes) per Stop-hook tick instead of O(full-transcript); rotation-safe monotonic token floor; fail-closed on Agent dispatches without timestamp
- `loadStateFromEvents` made read-only; explicit `recoverCacheFromEvents()` for crash-recovery under the lock
- `HistoryEventSchema` liberalized (open enum) so new event kinds don't break `saveState`
- History archive collision-safe filenames with `appendFileSync`
- Doctor's `budget-headroom` lifecycle-aware (no FAIL noise on achieved goals)
- Windows-safe `PLUGIN_ROOT` resolution via `fileURLToPath`
- Anti-flap clock-drift guard
- `<task-status>` parsing case-insensitive (`ACHIEVED` / `Achieved` / `achieved` all normalize)
- 5 Critical + 10 Important + 8 Minor audit findings closed, each with regression test

**Escape-hatch lifecycle gate (2.0.4):**
- New `awaiting-manual-approval` lifecycle state — set automatically when a reviewer's `subagent_type` is unavailable in the environment
- Stop hook renders the recovery prompt ONCE on the transition tick, then fully suppresses subsequent ticks (kills the spam loop where the controller agent kept emitting `<task-status>blocked</task-status>` toward a 3-strike `unmet`)
- `/goal-approve <task-id>` accepts the new lifecycle as a valid entry: clears `blocker_reason`, advances cursor, restores `pursuing`
- SessionStart hook surfaces the awaiting state on new session open (was previously silent)
- Doctor's new `awaiting-manual-approval` check warns with the three recovery options
- `/goal-resume` rejects with `/goal-approve` hint; `/goal-abandon` accepts; `/goal-pause` rejects (already idle)

### Earlier release notes

**v2.0.0 — stable.** Full v2-track ADR-0001 + ADR-0002 shipped. **All 7 G1 acceptance gates closed** (G1.1 determinism, G1.2 v1→v2 migration, G1.3 cold replay <500ms@10k events, G1.4 warm replay <100ms@10k, G1.5 crash injection 5 modes, G1.6 reducer purity lint, G1.7 self-meta against live goal). Cumulative: 15-kind event taxonomy, ULID-sorted log, pure reducer (no Date.now / Math.random / fs / process.env), snapshots, transactional turn batches, snapshot-aware loadStateFromEvents (forensic/recovery), v1→v2 migration, file-based advisory lock (ADR-0002, v1.3.0). Phase 8 reader-switch cutover deferred to v2.1.0 — requires apply-mutations refactor to fix dual-write doubling (filed as known limitation).

**v1.3.0 — stable.** Concurrent session locking landed (ADR-0002). Stability & UX SOTA pass (v1.2.0) + patch (v1.2.1) closing all ten self-critique gaps. All foundational phases plus seven new product surfaces:

**New in v1.2.0:**
- **`/goal-mode:goal-doctor`** — one-shot health diagnostic with 9 checks (state/tree validity, schema version, broken backups, cursor resolution, plugin pin freshness, Stop-hook liveness, budget headroom, event-log presence). Each check has a concrete fix command.
- **Schema migrations** — `engine/migrations.mjs` framework + v1→v2 first migration. Auto-applies on `loadState`/`loadTree`/`saveState`/`saveTree`/`validatePlan`. Preserves originals as `.pre-migration-v<N>-<ts>`.
- **Progress bar in every continuation prompt** — ASCII Sprint/Epic/Task/Overall progress block with █/░ bars + percentages.
- **SessionStart auto-resume hook** — new CC session in a project with active pursuing goal auto-injects the continuation prompt. No more typing "продолжай".
- **Resume UX rewrite** — distinct, actionable messages per lifecycle (no more misleading "No active goal" when state exists).
- **Reviewer-independence enforcement** — `<audit-verdict>` tags only count when the transcript shows a real `Agent(subagent_type=X)` invocation since the last `cursor-advanced`. Closes the "fabricated GO" loophole.
- **Event-log architecture** — append-only `events.jsonl` dual-written alongside `state.history`. Crash recovery via `loadStateWithRecovery` replays events to reconstruct missing state.
- **Two-layer output convention** — continuation prompts instruct assistants to write human-readable bullets ABOVE a `<details>` block containing machine tags. Conversation reads clean; engine still parses.

All foundational phases shipped:

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
