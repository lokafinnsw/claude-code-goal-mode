# 🔵 Goal continuation — review-pending

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

After all Agent calls return, emit one tag per reviewer:

```
<audit-verdict agent="<reviewer>" status="GO|NOGO|REVISE">verdict text</audit-verdict>
```

## Rules

- All reviewers must return GO before cursor advances.
- Any NOGO or REVISE → cursor stays on this task; engine increments review_attempts and gives you another pursuing turn to address concerns.
- 3 consecutive review cycles ending in NOGO mark this node `blocked` and may escalate to `unmet`.
- If a requested reviewer's `subagent_type` is unavailable in this environment, emit `<audit-verdict agent="<reviewer>" status="REVISE">unavailable; user must run /goal-approve</audit-verdict>` so the user is asked to manually approve.
- Do not write evidence tags this turn — only verdict tags.
