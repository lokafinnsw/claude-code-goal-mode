---
description: "Explain Goal Mode plugin and available commands"
---

# Goal Mode plugin help

## v3 Explicit CLI Verbs (recommended workflow)

In v3.0+, the Stop hook is hint-only on `lifecycle=pursuing` by default. Drive the goal explicitly:

| Command | Purpose |
|---|---|
| `/goal-mode:goal-current` | Show cursor task + AC coverage |
| `/goal-mode:goal-evidence-add` | Add evidence for a criterion |
| `/goal-mode:goal-achieve` | Claim achievement (advances cursor or → review-pending) |
| `/goal-mode:goal-review-request` | Print reviewer dispatch template |
| `/goal-mode:goal-submit-verdict` | Record reviewer verdict (GO/NOGO/REVISE) |
| `/goal-mode:goal-as-builtin` | Emit text for piping into built-in `/goal` |

**Recommended workflow:**
1. `/goal-mode:goal-current` — see the task.
2. Do the work in normal Claude Code mode.
3. For each AC: `/goal-mode:goal-evidence-add --criterion N --file path[:line] --note "..."`.
4. `/goal-mode:goal-achieve` — claim achievement.
5. If `review-pending`: `/goal-mode:goal-review-request` → dispatch reviewers via `Agent({subagent_type, prompt})` → `/goal-mode:goal-submit-verdict` per verdict.

Legacy v2 tag-emission workflow remains supported under `stopHookDriver: true` config (see [`docs/MIGRATION-v2-to-v3.md`]).

## Commands

| Command | Description |
|---|---|
| `/goal-plan <mission>` | Build a hierarchical plan tree from scratch (LLM bootstrap). Lifecycle → draft. |
| `/goal-plan-from-file <path>` | Convert an existing Markdown plan file into the goal-mode schema. Lifecycle → draft. Use this when you already have a plan in Markdown. |
| `/goal-approve-plan` | Validate the draft and lock it. Lifecycle → approved. |
| `/goal-start [--max-iter N] [--token-budget N] [--time-budget Nm\|Nh] [--force]` | Begin pursuing. Lifecycle → pursuing. `--force` to overwrite an existing active goal. |
| `/goal-status` | Show plan tree, cursor, budget, last events. |
| `/goal-tree` | Render the active plan as an ASCII tree with status glyphs (✓/▶/🔵/⛔/·). |
| `/goal-doctor [--fix] [--json]` | Diagnose health (state/tree, schema, backups, cursor, plugin pin, Stop-hook liveness, budget, event-log, retention). `--fix` applies safe auto-fixes. `--json` for machine output. |
| `/goal-pause` | Lifecycle → paused. Stop hook exits cleanly. |
| `/goal-resume` | Lifecycle → pursuing (refused if budget exhausted). |
| `/goal-approve [--reason "..."]` | Manually issue GO for current review-pending node. |
| `/goal-abandon --reason "..."` | Lifecycle → unmet (refused on terminal lifecycles). |
| `/goal-clear [--archive]` | Remove active goal directory. PERMANENT — pass `--archive` to snapshot to `.claude/goals/archive/<ts>-<goal_id>/` first. |
| `/goal-help` | This message. |

## Mental model

Goals are **plan-trees** (Sprint → Epic → Task), not flat objectives. Each task carries acceptance criteria and may carry a list of project-specific review agents that gate completion. The engine drives a Stop-hook continuation loop that re-renders a fresh continuation prompt every turn from on-disk state, so context loss between turns is harmless. The agent never edits state directly — it emits structured tags (`<evidence>`, `<task-status>`, `<review-request>`, `<audit-verdict>`, `<blocker>`) which the engine parses.

The engine knows nothing about your test framework, language, or review-agent names. The plan declares all of that.

## Lifecycle states

- `draft` — `/goal-plan` wrote a tree; not yet validated.
- `approved` — `/goal-approve-plan` validated + locked the tree.
- `pursuing` — `/goal-start` initialized budgets; agent is driving.
- `paused` — `/goal-pause`; Stop hook exits cleanly while paused.
- `achieved` — every leaf task achieved; terminal.
- `unmet` — 3 consecutive blocks on same node OR `/goal-abandon`; terminal.
- `budget-limited` — any of iter/tokens/wallclock exhausted; terminal.

## Triple budget

`/goal-start` sets three independent caps. Whichever exhausts first triggers `prompts/budget-limit.md`:
- **Iterations** — Stop-hook turns. Default 100.
- **Tokens** — sum of input + output + cache_creation across assistant rows in the session JSONL. Default 2,000,000.
- **Wall-clock** — seconds since `/goal-start`. Default 14400 (4h).

A budget value of 0 means "no limit" on that axis.

## State files

`.claude/goals/active/`:
- `tree.json` — the plan as data (zod-validated)
- `state.json` — runtime state (cursor, lifecycle, budget, history)
- `plan.md` — human-readable plan view
- `notes.md` — append-only digest, one line per iteration
- `audits/<node>-<ts>-<agent>.json` — one verdict per file

`.claude/goals/archive/<ISO-timestamp>-<goal_id>/` — snapshots created by `/goal-clear --archive`.

## Anti-patterns

- Do not edit `tree.json` or `state.json` directly. The engine validates schema on every load and will refuse corruption (writing the corrupt copy to `.broken-<ts>-<seq>.json` for forensic inspection). Edit `plan.md` only between `draft` and `approved` — re-run `/goal-approve-plan` after edits.
- Do not write `<task-status>achieved</task-status>` without `<evidence criterion="i" />` for every criterion. The engine refuses to mark a task achieved without evidence covering each criterion.
- Do not put real `<evidence>`, `<task-status>`, etc. tags inside markdown code fences (```...```) or backtick spans (`...`). The Stop hook strips code regions before parsing tags, so example/illustrative tags in code blocks are safely ignored — but real tags must be in prose.
- Do not use `<promise>` tags or other Ralph-style escape phrases — Goal Mode ignores them; only the documented tags are parsed.
