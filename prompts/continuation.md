# 🎯 Goal continuation — iteration {{iteration}}/{{iterations_max}}

## Position in plan
- **Sprint:** {{sprint_title}}
- **Epic:** {{epic_title}}
- **Task:** {{task_title}} (id: `{{task_id}}`)
- **Work front:** {{work_front}}

## Goal of this task
{{task_goal}}

## Acceptance criteria — none can be skipped
{{#each criteria}}
- [{{covered_marker}}] (#{{index}}) {{text}}
{{/each}}

## Already collected evidence
{{#each evidence}}
- iter {{iteration}}: criterion #{{criterion_index}} — {{note}}{{#if file}} ({{file}}{{#if line}}:{{line}}{{/if}}){{/if}}{{#if command}} `{{command}}` exit={{exit_code}}{{/if}}
{{/each}}

## What to do this turn
1. **Study the actual code/docs** related to this task. Do not paraphrase git log.
2. Make a concrete change OR collect verifying evidence.
3. Use these structured tags as you progress:
   - `<evidence file="path" line="N" criterion="i" note="why this proves criterion i" />` — one per criterion you cover.
   - `<evidence command="cmd" exit_code="0" criterion="i" note="..." />` — when verification is by shell command.
   - `<task-status>pursuing|achieved|blocked</task-status>` — your own assessment.
{{#if has_review}}
   - When you believe the task is achieved, you must request review: `<review-request agents="{{review_agents_csv}}"/>`. The cursor will not advance until every reviewer returns GO.
{{/if}}
{{#if has_validate}}
   - Run `{{validate}}` and attach exit code as `<evidence command="{{validate}}" exit_code="N" criterion="i" note="..." />`.
{{/if}}
4. **Do not accept proxy signals** as completion. "Tests passed" ≠ "criterion i is met". Map each criterion to specific evidence.
5. If the task is unsolvable in this scope: `<task-status>blocked</task-status>` plus `<blocker>reason</blocker>`. Do not silently skip.

## Anti-patterns (do not)
- Do not edit `.claude/goals/active/tree.json` or `state.json` directly. Emit tags; the engine will mutate state.
- Do not declare `<task-status>achieved</task-status>` without `<evidence criterion="i" .../>` for **every** criterion.
- Do not output a `<promise>` tag or any other escape phrase. The engine ignores them.

## Budget remaining
- Iterations: {{iteration}}/{{iterations_max}}
- Tokens: {{tokens_used}}/{{tokens_max}}
- Wall-clock: {{wallclock_minutes}}m / {{wallclock_max_minutes}}m
