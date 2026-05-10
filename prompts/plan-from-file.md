# Goal mode — plan from existing file

You are about to build a plan-tree for the user's mission. The user has provided an existing Markdown plan at:

```
{{file_path}}
```

Your job is to **convert that file into the goal-mode schema**, NOT to design a new plan from scratch. The user has already done the planning work — respect it.

## Hard rules — read first

1. **Read the file at `{{file_path}}` completely.** Use the Read tool. If it doesn't exist or is empty, abort and tell the user.

2. **The file is the authority.** Do not invent tasks the file does not mention. Do not drop tasks the file does include. The user wrote that plan deliberately; preserve their intent.

3. **Map the file's structure to Sprint → Epic → Task hierarchy.**
   - Most user files use H1 for the mission, H2 for top-level groups (Sprints or Phases), H3 for mid-level (Epics), H4 for tasks. If the file uses different heading levels (e.g., H2 directly to tasks with no epic layer), preserve the depth — every leaf is a task; intermediate nodes are sprints/epics in DFS order.
   - If the file uses `## Phase 1`, `## Phase 2`, treat each phase as a sprint.
   - If the file is flat (mission + bullet list of tasks), wrap the whole thing in one synthetic Sprint with one synthetic Epic; every bullet becomes a task.

4. **Acceptance criteria extraction.** Look for:
   - Bullet lists under the task heading.
   - Lines starting with `- [ ]` or `- ` followed by an observable condition.
   - Sub-headings like "**Acceptance criteria:**", "**Done when:**", "**Definition of done:**".
   - If a task has no clearly-marked acceptance_criteria, **synthesize ≥1 from the task title and goal** — every task must have at least one criterion (the engine's schema requires `acceptance_criteria.length >= 1` for tasks).
   - Phrase as observable conditions, NOT aspirational adjectives. "Tests pass" is too weak — "the function `foo` returns the correct value for inputs A, B, C" is right.

5. **Validate-command extraction.** Look for:
   - Inline code spans with `npm test`, `cargo test`, `pytest`, `go test`, `dotnet test`, etc.
   - Lines like `**Validate:**` or `**Test:**` or `**Run:**`.
   - If absent, **infer from the project's stack** — read `package.json` / `Cargo.toml` / `pyproject.toml` / etc. and pick the appropriate test command.
   - If still absent and stack unclear, leave `validate: null` for that task.

6. **Review-agent extraction.** Look for:
   - Lines like `**Review:**` or `**Reviewers:**` or `**Audit:**`.
   - Visual/UX/security/performance tasks SHOULD have `review: [...]`. Infer from content if not explicit.
   - Pick reviewer names from `~/.claude/{skills,agents}/` and `<cwd>/.claude/{skills,agents}/` — only declare reviewers that exist locally; for unavailable ones, leave as TODO with a note in chat (the user can enable manual override via `/goal:approve` later).

7. **Work-front extraction.** Look for:
   - `**Work front:**` or `**Track:**` annotations.
   - Section grouping by area (`## Engine work`, `## Frontend work`, etc.).
   - Default work fronts: `engine`, `art`, `narrative`, `audio`, `infra`, `docs`. Pick what fits.

8. **No placeholder strings.** The validatePlan business-rule layer rejects `TBD`, `TODO`, `FIXME`, `XXX`, `???` in titles, goals, and acceptance criteria. If the user's source file contains these, REPLACE them with concrete observable text. If you cannot determine a concrete value, ASK the user before writing.

## Output

Write THREE files in `.claude/goals/active/`:

### `tree.json` (machine, zod-valid)

Match the goal-mode schema. Set every node's `status: "pending"`, empty `evidence: []`, `review_attempts: 0`, etc. Set `schema_version: 1`. Set `goal_id` to a kebab-case slug derived from the file's H1 mission or the filename. Set `mission` to the H1 mission text (one-line). Set `created_at` to now ISO. Set `approved_at: null` (will be set by `/goal:approve-plan`).

### `plan.md` (human-readable, normalized)

Re-emit the plan in the goal-mode convention from `docs/PLAN-FORMAT.md`. This is a NORMALIZED copy — same content, but with consistent heading levels and field labels so `/goal:status` and the round-trip work cleanly. The user's original file is the authority; do not overwrite it.

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
**Review:** [<reviewer-1>]
**Validate:** `<command>`
**Work front:** <front>
```

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

`cursor` and `session_id` will be replaced by real values when `/goal:start` runs.

## After writing all three files

Tell the user, in chat:

1. **Source file path** — confirm what was read.
2. **Conversion summary** — how many sprints / epics / tasks were extracted.
3. **Schema deviations** — if the source file lacked acceptance criteria for some tasks and you synthesized them, list which tasks got synthesized criteria so the user can review.
4. **Reviewer availability** — which reviewer names you picked vs which were left as TODO because they're not in `~/.claude/{skills,agents}/`.
5. **Suggested budget for `/goal:start`** — based on task count: max-iter ≈ tasks × 4, token-budget ≈ tasks × 50000, time-budget ≈ tasks × 30 minutes; round up.
6. **Next step** — ask the user to read `.claude/goals/active/plan.md` (the normalized version), edit if needed, then run `/goal:approve-plan`.

Do NOT run `/goal:approve-plan` yourself; that's the user's gate.
