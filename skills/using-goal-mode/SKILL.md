---
name: using-goal-mode
description: Use when an active goal-mode plan-tree is driving the conversation (Stop hook fires continuation prompts, lifecycle is pursuing/paused/awaiting-manual-approval/blocked) OR before /goal-plan, /goal-start, /goal-approve, /goal-resume, /goal-abandon, /goal-clear — covers tag emission discipline, escape-hatch protocol, lifecycle states, anti-patterns, multi-session cross-project isolation, and recovery paths.
---

<SUBAGENT-STOP>
If you were dispatched as a subagent to execute a specific task (e.g., a reviewer Agent), skip this skill. Reviewers do not emit `<task-status>` or `<evidence>` tags — they emit `<audit-verdict>` only, per `commands/goal-review.md`. The driving (controller) agent is the one who reads this skill.
</SUBAGENT-STOP>

# Working with goal-mode

This skill teaches you (the controller agent driving a goal) how to interact with the goal-mode engine **without breaking it**, without spam-looping the chat, and without falsely declaring achievement. Read it once per conversation when a goal is active; the rules don't change between turns.

The full functional reference is in `commands/goal-help.md` (the slash command `/goal-mode:goal-help`). This skill focuses on **behavior**: when to do what, what NOT to do, and how to recover from edge cases.

## Mental model (60 seconds)

- A **goal** is a hierarchical plan-tree: **Sprint → Epic → Task**. Each task has acceptance criteria + optional review-agents that gate completion.
- The engine fires a **Stop hook** on every assistant turn while `lifecycle == 'pursuing'`. The Stop hook reads on-disk state, computes the next continuation prompt, and injects it as the next user-turn input. Context loss between turns is harmless — state lives on disk.
- You (the controller) never edit `state.json` or `tree.json` directly. You emit structured **tags** in your text. The engine parses tags and mutates state.
- The cursor moves forward only when every required review-agent returns `GO`, OR when the user runs `/goal-mode:goal-approve`. The engine prevents proxy-signal collapse (you can't fabricate verdicts on a reviewer's behalf).
- Triple budget (iterations / tokens / wallclock) is enforced; exhaustion is `budget-limited` lifecycle.

## Lifecycle states — what each means and what you should do

| Lifecycle | Meaning | What you do |
|---|---|---|
| `draft` | `/goal-plan` wrote a tree, not validated | Wait for `/goal-approve-plan` |
| `approved` | Plan locked, no budgets yet | Wait for `/goal-start` |
| `pursuing` | Active work | Read Stop-hook prompt, do work, emit evidence + task-status |
| `paused` | User explicitly paused | Don't fire Stop work (engine returns null stdout). Wait for `/goal-resume` |
| `awaiting-manual-approval` | **v2.0.4** — escape-hatch from unavailable reviewer | Engine has STOPPED firing Stop-hook prompts. You wait silently for user `/goal-mode:goal-approve <task-id>` or `/goal-abandon`. **Do not** re-emit tags trying to fix this — environmental issue |
| `achieved` | Every leaf task achieved; terminal | Engine renders `final-summary.md` once; no further turns |
| `unmet` | 3 consecutive blocks/NOGOs OR `/goal-abandon`; terminal | Engine renders `unmet-summary.md` once; recovery via `/goal-clear --archive` + replan |
| `budget-limited` | Iter/tokens/wallclock cap hit; terminal | Engine renders `budget-limit.md`; recovery via `/goal-resume` with fresh budget OR `/goal-clear` |

## Tag emission discipline

The engine parses these tags from your text. Get them wrong and the engine ignores them silently.

### Always-emit tags (per turn while pursuing)

```
<evidence file="path/to/file" line="N" criterion="i" note="short proof"/>
<task-status>pursuing|achieved|blocked</task-status>
```

- **Every `<evidence>` MUST have an integer `criterion="i"` attribute**, where `i` is in `[0, len(acceptance_criteria))`. Missing or out-of-range → silently dropped from coverage check, but kept in the cursor's evidence list (the engine logs it; reviewers can read it).
- Task is `achieved` ONLY when every criterion has at least one evidence entry AND every required reviewer returned GO. The engine refuses to mark `achieved` otherwise — you'll get the same prompt next turn.
- `<task-status>` values are case-insensitive (v2.0.3 fix): `ACHIEVED`, `Achieved`, `achieved` all normalize to `achieved`.

### Conditional tags

```
<review-request agents="reviewer-1,reviewer-2"/>   <!-- self-closed; comma-separated -->
<blocker>reason text</blocker>                      <!-- pair with task-status:blocked -->
<audit-verdict agent="reviewer-x" status="GO|NOGO|REVISE">verdict body</audit-verdict>
```

- `<review-request>` triggers transition `pursuing → review-pending` when all criteria are covered. Optional — if a task's `review` array is empty in the plan, the cursor advances on `<task-status>achieved</task-status>` immediately.
- `<audit-verdict>` is for **reviewers**, not the controller. You (controller) emit it ONLY when the reviewer subagent has actually returned a verdict and you are relaying it (with the same agent name + status the subagent gave).

### The two-layer output convention

The Stop-hook templates ask for this format:

```
**Retry — taskName()**

What I changed:
- bullet 1
- bullet 2

How it now covers the criteria:
- AC#0 — short summary
- AC#1 — short summary

<details>
<summary>engine evidence (machine-parsed)</summary>

<evidence file="path" line="N" criterion="0" note="..."/>
<evidence file="path" line="N" criterion="1" note="..."/>
<task-status>achieved</task-status>
</details>
```

- Bullets at the top → what the user reads
- Tags inside `<details>` → what the engine parses
- **Never** wrap tags in ``` fenced code blocks or `inline backticks` — the Stop hook strips code regions before parsing (`stripCodeRegions`). Example tags in prose-rendered prompts are intentionally ignored; real tags must be in prose.

## Reviewer-independence enforcement (v2.0.0+)

The engine enforces that `<audit-verdict>` tags can only be ACCEPTED when there is a matching `Agent(subagent_type=...)` invocation in the same turn's transcript. This is the "scannedAgents" check.

**What this means for you:**
- To get a real GO from a reviewer, you MUST actually call `Agent({subagent_type: "<reviewer-name>", ...})`. The engine reads the transcript and verifies the dispatch happened.
- Verdicts emitted without a matching dispatch are **rejected** as fabricated. They land in `state.history` with `payload.rejected: true` and don't advance the cursor.
- Pre-v2.0.0 you could write a `<audit-verdict agent="X" status="GO">looks fine to me</audit-verdict>` and the engine would honor it. The new check kills that path.

## Escape-hatch protocol (v2.0.1 + v2.0.4)

**Scenario:** A reviewer's `subagent_type` is not registered as an Agent in the current Claude environment, so `Agent({subagent_type: "...", ...})` returns `Agent type not found`. This happens when the project's plan refers to a reviewer that exists only as a **Skill** (markdown file at `~/.claude/skills/<name>/`) but lacks a paired **Agent** file (markdown file at `~/.claude/agents/<name>.md` with matching `name:` frontmatter).

### Skill vs Agent — the conceptual gap

These are two different things in Claude Code:

| | Skill | Agent |
|---|---|---|
| File location | `~/.claude/skills/<name>/SKILL.md` | `~/.claude/agents/<name>.md` |
| Activated by | `Skill` tool with `skill: "name"` | `Agent` tool with `subagent_type: "name"` |
| Runs in | Current session, instructions inlined | Separate subagent context |
| For reviews | NO — can't return a verdict to the parent | YES — independent subagent verdict |

**If a goal-mode plan declares a reviewer that only exists as a Skill, the engine's `Agent(subagent_type=...)` dispatch will fail.** You need to either:

1. **Register the matching Agent** — create `~/.claude/agents/<name>.md` with YAML frontmatter `name: <name>` and a description + tool whitelist + body (can mirror the skill's content). Then `Agent({subagent_type: "<name>"})` resolves and the reviewer-independence check passes.
2. **Use the escape-hatch verdict** — see below.

### Emitting the escape-hatch verdict

When you've tried `Agent({subagent_type: "X"})` and got `Agent type not found`, emit:

```
<audit-verdict agent="X" status="REVISE">unavailable; user must run /goal-approve</audit-verdict>
```

**Exact format requirements:**
- `status="REVISE"` (not NOGO, not GO)
- Text starts with **`unavailable`** (case-insensitive, optional leading whitespace). The engine's regex is `/^\s*unavailable\b/i`.
- The phrase `user must run /goal-approve` is conventional but not strictly required by the regex — anything starting with "unavailable" matches.

### What happens after escape-hatch emission

In v2.0.4:
1. The engine recognizes the escape-hatch pattern and marks the cursor `blocked` with `blocker_reason` listing the unavailable reviewer(s) + recovery options.
2. **The engine transitions `state.lifecycle` to `awaiting-manual-approval`** (terminal-but-recoverable).
3. The current Stop hook renders `continuation-blocked.md` ONE more time so the user sees the recovery instructions.
4. **All subsequent Stop hooks return null stdout** — no more continuation prompts, no spam loop.
5. **You stop emitting anything related to this task.** The user must take action: `/goal-mode:goal-approve <task-id>` (manual override) OR register the missing Agent file OR `/goal-mode:goal-abandon`.

### Anti-pattern (pre-v2.0.4 trap that no longer exists, but agents still try)

❌ Re-emitting `<task-status>blocked</task-status>` over and over with the same blocker reason. Pre-v2.0.4 this ticked `review_attempts` toward the 3-strike `unmet` threshold and killed the goal from purely environmental cause. v2.0.4's lifecycle gate makes this impossible (the Stop hook stops firing). But: **the underlying anti-pattern is "trying to fix an environmental problem from code"**. You can't conjure a missing Agent file into existence. Stop trying. Wait for the user.

## What to do during `awaiting-manual-approval`

The lifecycle has structural effects:

- Stop hook returns null stdout → no continuation prompt → the user's chat is no longer blocked by goal-mode.
- The user sees the SessionStart hint when they open a new session (v2.0.4 addition): "active goal is waiting for manual approval, run /goal-mode:goal-approve <task-id>".
- Doctor reports it as `warn` with action.

**What YOU (controller) do:**
- Stop emitting tags for this task. The engine has terminated this work front pending user action.
- If the user asks unrelated questions, answer them. The goal-mode lifecycle gate doesn't block other work.
- If the user asks about the goal status, run `/goal-mode:goal-status` or `/goal-mode:goal-doctor` and explain the three recovery paths:
  1. `/goal-mode:goal-approve <task-id>` — manual GO, restores `lifecycle=pursuing`, advances cursor.
  2. Register `~/.claude/agents/<name>.md` for the missing reviewer, then `/goal-mode:goal-abandon` + replan (the existing escape-hatch can't be retried in-place — but a fresh goal will dispatch the now-available reviewer normally).
  3. `/goal-mode:goal-abandon` if the goal is no longer wanted.

## Multi-session / cross-project isolation (v2.0.2 + v2.0.3)

Goal-mode is scoped per-project via `<projectRoot>/.claude/goals/active/`. The hooks resolve `projectRoot` from Claude Code's `stdin.cwd` field, NOT `process.cwd()` (v2.0.2 fix). This means:

- Multiple Claude Desktop session tabs, each opened to a different project, each get their own goal-mode state. mancelot's continuation never leaks into another project's session.
- A single Claude Code session is rooted in ONE project. If you open Claude Desktop from `/Users/foo/projectA`, that session's `stdin.cwd` is `/Users/foo/projectA`, and all goal-mode work happens against `projectA/.claude/goals/active/`.
- `cd`-ing inside the shell during the session does NOT change which project the goal-mode hooks read from — `stdin.cwd` is set per-event by Claude Code, not by your shell's cwd.

**Implication for you (controller):**
- If you find yourself working on plugin code while the goal-mode session is rooted in a different project, the Stop hook will keep firing for THAT project's goal. You can't suppress it from inside the session — the user has to either:
  - Open a separate Claude Desktop session for the project you actually want to work on.
  - `/goal-mode:goal-pause` the current goal so its Stop hook stops firing.

## Recovery paths summary

| Situation | What to do |
|---|---|
| Task achieved, want to advance | Emit `<evidence ...>` + `<task-status>achieved</task-status>` |
| Reviewer needed, but criteria met | Emit `<review-request agents="..."/>`, then on next turn dispatch `Agent({subagent_type: "..."})` and relay verdicts |
| Reviewer NOGO/REVISE | Cursor returns to `pursuing`, `review_attempts++`. After 3 cycles → `blocked` then `unmet` |
| Reviewer subagent_type unavailable | Emit escape-hatch verdict (see above). Engine → `awaiting-manual-approval`. Wait for user |
| Genuinely can't make progress on a task | Emit `<task-status>blocked</task-status>` + `<blocker>reason</blocker>`. After 3 consecutive blocks → `unmet` |
| Budget about to exhaust | Doctor's `budget-headroom` warns at 75%, fails at 95%. Suggest `/goal-mode:goal-pause` for scope review |
| State.json or tree.json corrupt | `recoverCacheFromEvents(projectRoot)` in engine; or doctor's `state-loadable` check + `.broken-*` backups |
| Goal already `unmet` and you want to retry | `/goal-mode:goal-clear --archive`, then replan (`/goal-plan-from-file` or `/goal-plan`) |
| Need to stop a goal permanently | `/goal-mode:goal-abandon --reason "..."` (lifecycle → `unmet`) |

## Anti-patterns — categorically forbidden

1. ❌ **Never** hand-edit `state.json`, `tree.json`, or `events.jsonl`. The engine validates schemas; corrupt files go to `.broken-<ts>-<seq>.json`. Use commands.
2. ❌ **Never** emit `<task-status>achieved</task-status>` without `<evidence criterion="i"/>` for **every** criterion of the cursor task. The engine refuses and re-fires the same prompt.
3. ❌ **Never** wrap real engine tags in markdown code fences (` ``` `) or backtick spans (` ` ` `). The Stop hook strips code regions before parsing.
4. ❌ **Never** fabricate `<audit-verdict>` tags. The engine's reviewer-independence check rejects verdicts without matching `Agent` dispatch. Even for reviewers the engine knows about — you MUST actually dispatch the Agent.
5. ❌ **Never** re-emit the same blocker repeatedly after escape-hatch fires (v2.0.4 makes this harmless but the intent is wrong). When the engine is in `awaiting-manual-approval`, stop emitting goal-mode tags for that task. Wait.
6. ❌ **Never** treat "Stop hook fired the same prompt twice in a row" as a reason to escalate. It means YOUR last turn didn't change state. Re-read the prompt, do real work, emit real tags.
7. ❌ **Never** invoke `/goal-mode:goal-clear` without `--archive` unless the user explicitly confirmed. `clear` is permanent deletion.
8. ❌ **Never** use `<promise>` or other "Ralph-style" escape phrases. Goal-mode parses only documented tags.
9. ❌ **Never** report "tests pass" alone as evidence for a criterion that requires substantive proof (e.g., visual capture, runtime screenshot). Map each criterion to specific file lines / screenshots / metrics.

## Plugin maintenance — when to suggest the user upgrade

If you encounter behavior matching these old-version symptoms, suggest the user upgrade:

| Symptom | Affected versions | Fixed in |
|---|---|---|
| Infinite loop after reviewer unavailable | 2.0.0 (only) | 2.0.1 |
| Same goal's continuation appears in OTHER projects | ≤ 2.0.1 | 2.0.2 |
| SessionStart renders review/blocked template with empty `{{audit_instructions}}` | ≤ 2.0.2 | 2.0.3 |
| `.claude/goals/active/` dirs created in every project the user touches | ≤ 2.0.2 | 2.0.3 |
| Stop hook reads entire transcript every tick (laggy on long sessions) | ≤ 2.0.2 | 2.0.3 |
| Tokens count silently decreases after `/compact` | ≤ 2.0.2 | 2.0.3 |
| Doctor's `budget-headroom` shows FAIL on achieved goal | ≤ 2.0.2 | 2.0.3 |
| Repeated "Не лезу" / minimum-text loop after escape-hatch | ≤ 2.0.3 | 2.0.4 |
| Goal terminates `unmet` from environmental cause (missing reviewer Agent) | ≤ 2.0.3 | 2.0.4 |

Upgrade procedure:
```bash
cd /path/to/claude-code-goal-mode && bash install.sh
# then: full restart of Claude Desktop (kill + relaunch, not just plugin reload)
```

## Quick reference: state-file paths

```
<projectRoot>/.claude/goals/active/
├── tree.json                     # plan tree, zod-validated, v2 schema
├── state.json                    # runtime state (cursor, lifecycle, budget, history)
├── plan.md                       # human-readable plan view
├── notes.md                      # append-only digest (one line per Stop-hook fire)
├── events.jsonl                  # ADR-0001 event log (canonical truth)
├── .transcript-cache.json        # v2.0.3 incremental scan checkpoint
├── .lock                         # ADR-0002 advisory lock (only present during writes)
├── audits/                       # per-verdict JSON files
└── snapshots/                    # periodic full-state snapshots for fast recovery

<projectRoot>/.claude/goals/archive/
└── <ISO-timestamp>-<goal_id>/    # created by /goal-clear --archive
```

## Quick reference: the most useful commands

- `/goal-mode:goal-status` — current cursor, lifecycle, budget, last events
- `/goal-mode:goal-tree` — ASCII tree with status glyphs (✓ achieved / ▶ pursuing / 🔵 review-pending / ⛔ blocked / · pending)
- `/goal-mode:goal-doctor` — 13 health checks. Run this when anything looks wrong.
- `/goal-mode:goal-doctor --fix` — apply safe auto-fixes (broken-backups GC, pre-migration backup retention)
- `/goal-mode:goal-approve <task-id>` — manual GO override, also handles awaiting-manual-approval
- `/goal-mode:goal-pause` — pause Stop hook firing
- `/goal-mode:goal-resume` — restore pursuing (refuses if any budget exhausted)
- `/goal-mode:goal-abandon --reason "..."` — terminate as `unmet`
- `/goal-mode:goal-clear --archive` — permanently delete active goal dir (archives first)

## Reading the Stop-hook prompt

When a Stop hook fires, you receive a continuation prompt with one of three shapes:

1. **`continuation.md`** (cursor status=pursuing) — normal work, emit evidence + task-status
2. **`continuation-review.md`** (cursor status=review-pending) — dispatch reviewer Agent(s), relay verdicts via `<audit-verdict>`. If you see `## ⚠ Rejected verdicts from this review cycle`, the prior turn's verdicts were rejected — dispatch the missing Agent THIS turn before re-emitting.
3. **`continuation-blocked.md`** (cursor status=blocked) — either retry with fresh evidence (real work) or re-emit `<task-status>blocked</task-status>` with a new `<blocker>`. **If the prompt has a `## ⚠ Reviewer agent unavailable in this environment` section** — this is the escape-hatch case. Stop emitting tags; wait for user `/goal-approve`.

There's also `final-summary.md`, `unmet-summary.md`, `budget-limit.md` — terminal templates. After these, no further Stop hooks fire.

## Subagent-driven reviews — for the controller

When you dispatch a reviewer:

```
Agent({
  subagent_type: "<reviewer-name>",
  description: "Review task <task-id>",
  prompt: "<audit instructions body — comes from audit-instructions.md template, rendered in continuation-review.md>"
})
```

The reviewer subagent runs in isolation. It returns a verdict via its own output. You relay it via:

```
<audit-verdict agent="<reviewer-name>" status="GO|NOGO|REVISE">
  <full text of reviewer's verdict>
</audit-verdict>
```

The engine matches `agent` against the subagent_types you actually dispatched this turn. If you relay a verdict from a reviewer you didn't dispatch, it's rejected as fabricated.

**Multi-reviewer:** dispatch each one (one Agent call per reviewer) within the same turn, then emit one `<audit-verdict>` per reviewer. The engine requires every required reviewer to return GO before advancing.

## When to use this skill

Invoke `using-goal-mode` skill:

- At the start of any conversation where `lifecycle == 'pursuing'` (Stop hook prompts are firing).
- Before running `/goal-mode:goal-plan`, `/goal-mode:goal-start`, `/goal-mode:goal-approve`, `/goal-mode:goal-resume`, `/goal-mode:goal-abandon`, or `/goal-mode:goal-clear`.
- When the user mentions any goal-mode lifecycle state (pursuing, blocked, awaiting-manual-approval, achieved, unmet, budget-limited).
- When you see a Stop-hook prompt with `## ⚠ Reviewer agent unavailable in this environment` or `## ⚠ Rejected verdicts from this review cycle`.

Skip the skill (`SUBAGENT-STOP` at top) if you were dispatched as a reviewer subagent — your job is to emit `<audit-verdict>` per `commands/goal-review.md`, not to drive the goal.

## Companion skill

For deep dives into tag parsing semantics, the parser's edge cases (case-insensitivity in v2.0.3+, attribute quoting rules, code-fence stripping), and the exact regexes the Stop hook uses, see the `goal-mode-tag-discipline` skill.
