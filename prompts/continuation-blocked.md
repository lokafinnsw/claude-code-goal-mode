# ⛔ Goal continuation — task is blocked (attempt {{review_attempts}}/3)

The task **{{task_title}}** (id: `{{task_id}}`) is currently blocked.

**Last blocker reason:** {{blocker_reason}}
{{#if last_verdicts}}

**Last review verdicts:**
{{#each last_verdicts}}- {{agent}} ({{status}}): {{text}}
{{/each}}{{/if}}

## Acceptance criteria still uncovered
{{#each uncovered_criteria}}- (#{{index}}) {{text}}
{{/each}}

## What to do this turn

1. Reread the criteria above and the verdicts/blocker. Decide concretely what to change.
2. Make the change, then either:
   - Re-emit `<task-status>achieved</task-status>` with NEW evidence covering the previously-uncovered criteria; this re-triggers review.
   - Or, if you believe the task as-stated is impossible, emit `<task-status>blocked</task-status>` with a fresh `<blocker>reason</blocker>`. After 3 consecutive blocks the goal escalates to `unmet`.

3. Do not declare `achieved` without addressing the verdicts/criteria — the engine will reject it.
