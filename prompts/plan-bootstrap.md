# Goal mode — plan bootstrap

You are about to build a plan-tree for the user's mission. Mission text follows below the marker.

## Hard rules — read first

1. **Genuinely study the project.** Read README, package.json / Cargo.toml / pyproject.toml / .csproj / go.mod / etc. Run `git log --oneline -n 30`. Skim `.claude/skills/` (project + global) and `.claude/agents/` to know what subagents exist HERE.
   - Do NOT paraphrase git log. Do NOT invent code structure. Read actual files.

2. **Identify the stack.** Decide which test runner, build tool, and package manager apply. The plan's `validate` fields will use real commands from this stack — `npm test`, `cargo test`, `pytest`, `go test`, `dotnet test`, etc. — not placeholders.

3. **Survey available subagents.** Each task that produces a visual or quality-critical artifact needs a `review[]` field. Pick subagent_type names from the actual installed skills/agents in this environment. Do not invent names. If no suitable reviewer exists, leave `review:[]` and note it; the user can manually approve.

4. **Decompose the mission** into Sprint → Epic → Task hierarchy:
   - **Sprint:** ~1 week of work, single coherent outcome.
   - **Epic:** ~1 day of work, cross-cuts files but is bounded.
   - **Task:** ≤4 hours of focused work, **one function or one file's worth of change**.

5. **Acceptance criteria are non-negotiable.** Every task gets ≥1 acceptance_criteria entry. Phrase as observable conditions, not aspirational adjectives. "Tests pass" is too weak — "the function `foo` returns the correct value for inputs A, B, C" is right. The user's standing rule: criteria exist to prevent corner-cutting later.

6. **Visual tasks REQUIRE review.** Any task that produces UI, art, level design, or game-feel changes must include `review:[<project-appropriate-reviewer>]`. The reviewer string is opaque to the engine; pick what makes sense for THIS project's domain.

7. **Work fronts.** Group tasks by `work_front` so the user can see parallel tracks. Common fronts: `engine`, `art`, `narrative`, `audio`, `infra`, `docs`. Use what fits the project.

## Output

By the end of this turn, all three files MUST exist on disk:
- `.claude/goals/active/tree.json`
- `.claude/goals/active/plan.md`
- `.claude/goals/active/state.json`

Use ONE Write tool call per file. Three Writes total.

Write TWO files in `.claude/goals/active/`:

### `plan.md` (human-readable)

```markdown
# Mission: <one-line>

## Sprint 1: <title> {#sprint-1}
**Goal:** <statement>
**Work front:** <front>

### Epic 1.1: <title> {#sprint-1.epic-1}
**Goal:** <statement>

#### Task 1.1.1: <title> {#sprint-1.epic-1.task-1}
**Goal:** <statement>
**Acceptance criteria:**
- <criterion>
- <criterion>
**Review:** [<reviewer-1>, <reviewer-2>]
**Validate:** `<command>`
**Work front:** <front>

#### Task 1.1.2: ...
```

### `tree.json` (machine, zod-valid)

Same hierarchy in JSON matching the GoalTreeSchema. Set every node's `status: "pending"`, empty `evidence: []`, `review_attempts: 0`, etc. Set `schema_version: 1`. Set `goal_id` to a slug of the mission. Set `created_at` to now ISO. Set `approved_at: null` (will be filled by `/goal-approve-plan`).

### `state.json` (machine, zod-valid)

Minimal draft state. Match `engine/state.mjs::GoalStateSchema`:

```json
{
  "schema_version": 1,
  "goal_id": "<the slug from tree.goal_id>",
  "lifecycle": "draft",
  "cursor": "pending",
  "budget": {
    "iterations": { "used": 0, "max": 0 },
    "tokens": { "used": 0, "max": 0 },
    "wallclock": { "started_at": "<now ISO>", "max_seconds": 0 }
  },
  "session_id": "pending",
  "started_at": null,
  "paused_at": null,
  "ended_at": null,
  "ended_reason": null,
  "history": []
}
```

`cursor`, `session_id`, and budget caps are placeholders — they will be replaced when `/goal-start` runs.

## After writing all three files

Tell the user, in chat:
1. The counts: how many sprints, epics, tasks.
2. The work fronts you used.
3. The reviewers you proposed (and which ones are unavailable in this environment).
4. Suggested budget for `/goal-start`: based on task count, estimate (max-iter ≈ tasks × 4, token-budget ≈ tasks × 50000, time-budget ≈ tasks × 30 minutes; round up).
5. Ask them to read `plan.md`, edit if needed, then run `/goal-approve-plan`.

Mission to plan:

---
{{mission}}
---
