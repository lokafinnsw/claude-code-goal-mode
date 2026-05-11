# ⛔ Goal continuation — task is blocked (attempt {{review_attempts}}/3)

## Progress
```
{{progress_block}}
```

The task **{{task_title}}** (id: `{{task_id}}`) is currently blocked.

**Last blocker reason:** {{blocker_reason}}
{{#if last_verdicts}}

**Last review verdicts:**
{{#each last_verdicts}}- {{agent}} ({{status}}): {{text}}
{{/each}}{{/if}}
{{#if unavailable_reviewers}}

## ⚠ Reviewer agent unavailable in this environment

The cursor is stuck because the following reviewer subagent_type(s) are NOT registered in your current Claude environment: **{{unavailable_reviewers_csv}}**.

**Recovery (pick one):**

1. **Manual approve** — fastest, no setup. In the goal's session, run:
   ```
   /goal-mode:goal-approve {{task_id}}
   ```
   This bypasses the missing reviewer for this task and advances the cursor.

2. **Register the reviewer agent** — durable, fixes future review gates too. Create `~/.claude/agents/<agent-name>.md` with YAML frontmatter:
   ```
   ---
   name: <one of {{unavailable_reviewers_csv}}>
   description: <one-line description>
   tools: Read, Bash, Grep, Glob
   ---
   <body of reviewer system prompt>
   ```
   Then reload the plugin / restart the CLI and re-emit `<task-status>achieved</task-status>` with fresh evidence; the engine will dispatch the now-available reviewer automatically.

3. **Revise the plan** — if the named reviewer is the wrong agent for this task, edit the tree's `review` field for this node and reload the goal.

After applying one of the recoveries, the next Stop-hook turn will pick up the new state — no further action needed in this prompt.
{{/if}}

## Acceptance criteria still uncovered
{{#each uncovered_criteria}}- (#{{index}}) {{text}}
{{/each}}

## What to do this turn

1. Reread the criteria above and the verdicts/blocker. Decide concretely what to change.
2. Make the change, then either:
   - Re-emit `<task-status>achieved</task-status>` with NEW evidence covering the previously-uncovered criteria; this re-triggers review.
   - Or, if you believe the task as-stated is impossible, emit `<task-status>blocked</task-status>` with a fresh `<blocker>reason</blocker>`. After 3 consecutive blocks the goal escalates to `unmet`.

3. Do not declare `achieved` without addressing the verdicts/criteria — the engine will reject it.

## Output format

Same two-layer convention as `continuation.md`: write a human-readable summary FIRST (what changed, why it now covers the previously-uncovered criteria), then put machine tags inside a `<details>` block at the end:

```
**Retry — {{task_title}}**

What I changed:
- <bullet 1>
- <bullet 2>

How it now covers the criteria:
- **AC#i** — short summary

<details>
<summary>engine evidence (machine-parsed)</summary>

<evidence file="..." line="N" criterion="i" note="..." />
<task-status>achieved</task-status>
</details>
```
