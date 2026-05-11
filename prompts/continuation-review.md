# 🔵 Goal continuation — review-pending

## Progress
```
{{progress_block}}
```

{{#if has_rejected_verdicts}}
## ⚠ Rejected verdicts from this review cycle

The following verdicts were **rejected** by the engine because no matching `Agent` tool_use was found in the transcript. You MUST actually invoke the Agent tool with the named `subagent_type` before emitting a verdict — fabricated verdicts are detected and discarded.

{{#each rejected_verdicts}}- agent `{{agent}}` (status={{status}}) rejected: {{reason}}
{{/each}}
**Action:** dispatch each rejected reviewer via the Agent tool (see template below) BEFORE re-emitting the verdict tag.

{{/if}}
The task **{{task_title}}** (id: `{{task_id}}`) declared itself achieved. Before the cursor advances, you must collect independent verdicts from every reviewer in this list:

**Reviewers required:** {{review_agents_csv}}

## What to do this turn

For each reviewer above, invoke the Agent tool:

```
Agent({
  subagent_type: "<one of {{review_agents_csv}}>",
  description: "Review task {{task_id}}",
  prompt: <see audit-instructions.md content>
})
```

The audit instruction body to pass into each Agent call is below — use it verbatim, substituting the reviewer name where indicated:

---
{{audit_instructions}}
---

After all Agent calls return, write a human-readable summary FIRST, then put the machine verdict tags inside a `<details>` block at the end:

```
**Review verdicts for {{task_title}}**

- **<reviewer-1>** — GO: short reason (or NOGO/REVISE: short reason)
- **<reviewer-2>** — GO: short reason
<details>
<summary>engine verdicts (machine-parsed)</summary>

<audit-verdict agent="<reviewer-1>" status="GO">full verdict text from agent</audit-verdict>
<audit-verdict agent="<reviewer-2>" status="GO">full verdict text from agent</audit-verdict>
</details>
```

The bullets above are what the user reads; tags inside `<details>` are what the engine consumes. Do NOT wrap tags in fenced code blocks (\`\`\`) — `stripCodeRegions` removes them before parsing.

## Rules

- All reviewers must return GO before cursor advances.
- Any NOGO or REVISE → cursor stays on this task; engine increments review_attempts and gives you another pursuing turn to address concerns.
- 3 consecutive review cycles ending in NOGO mark this node `blocked` and may escalate to `unmet`.
- If a requested reviewer's `subagent_type` is unavailable in this environment, emit `<audit-verdict agent="<reviewer>" status="REVISE">unavailable; user must run /goal-approve</audit-verdict>` so the user is asked to manually approve.
- Do not write evidence tags this turn — only verdict tags.
