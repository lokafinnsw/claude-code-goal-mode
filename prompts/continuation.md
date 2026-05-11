# 🎯 Goal continuation — iteration {{iteration}}/{{iterations_max}}

## Progress
```
{{progress_block}}
```

## Position in plan
- **Sprint:** {{sprint_title}}
- **Epic:** {{epic_title}}
- **Task:** {{task_title}} (id: `{{task_id}}`)
- **Work front:** {{work_front}}

## Goal of this task
{{task_goal}}

## Acceptance criteria — none can be skipped
{{#each criteria}}- [{{covered_marker}}] (#{{index}}) {{text}}
{{/each}}
## Already collected evidence
{{#each evidence}}- iter {{iteration}}: criterion #{{criterion_index}} — {{note}}{{#if file}} ({{file}}{{#if line}}:{{line}}{{/if}}){{/if}}{{#if command}} `{{command}}` exit={{exit_code}}{{/if}}
{{/each}}

## What to do this turn
1. **Study the actual code/docs** related to this task. Do not paraphrase git log.
2. Make a concrete change OR collect verifying evidence.
3. **Two-layer output convention** — write a human-readable summary FIRST, then put machine tags inside a `<details>` block at the end of your turn. The Stop-hook engine parses tags regardless of surrounding markdown, so they work the same; the human reading the conversation sees a clean summary instead of a wall of XML attributes.

   Recommended shape for an "achieved" turn:

   ```
   **{{task_title}}** ✅

   - **AC#0** — short plain-language summary of how you verified it (1 line)
   - **AC#1** — same
   {{#if has_validate}}- **Validation** — `{{validate}}` exit 0
   {{/if}}
   <details>
   <summary>engine evidence (machine-parsed)</summary>

   <evidence file="path" line="N" criterion="0" note="..." />
   <evidence file="path" line="N" criterion="1" note="..." />
   <task-status>achieved</task-status>{{#if has_review}}
   <review-request agents="{{review_agents_csv}}"/>{{/if}}
   </details>
   ```

   Bullets above the `<details>` are what the user reads. Tags inside `<details>` are what the engine consumes — never skip them or wrap them in fenced code blocks (\`\`\`), the parser strips fenced regions before tag extraction.

4. **Do not accept proxy signals** as completion. "Tests passed" ≠ "criterion i is met". Map each criterion to specific evidence.
5. If the task is unsolvable in this scope: `<task-status>blocked</task-status>` plus `<blocker>reason</blocker>`. Do not silently skip.

## Tag reference (full schema)
- `<evidence file="path" line="N" criterion="i" note="..." />` — file-based proof for criterion `i`.
- `<evidence command="cmd" exit_code="0" criterion="i" note="..." />` — shell-command proof.
- `<task-status>pursuing|achieved|blocked</task-status>` — assessment.
{{#if has_review}}- `<review-request agents="{{review_agents_csv}}"/>` — required when claiming achieved; cursor will not advance until every reviewer returns GO.
{{/if}}{{#if has_validate}}- `<evidence command="{{validate}}" exit_code="N" criterion="i" note="..." />` — wraps the validate hook into evidence.
{{/if}}- `<blocker>reason</blocker>` — pair with `<task-status>blocked</task-status>` for unsolvable scope.

## Anti-patterns (do not)
- Do not edit `.claude/goals/active/tree.json` or `state.json` directly. Emit tags; the engine will mutate state.
- Do not declare `<task-status>achieved</task-status>` without `<evidence criterion="i" .../>` for **every** criterion.
- Do not wrap tags in fenced code blocks (\`\`\`) — `stripCodeRegions` removes them before parsing, so the engine won't see them.
- Do not stuff multi-paragraph essays into the `note=` attribute. Keep notes ≤ 200 chars; put the long-form rationale in the human bullet ABOVE the `<details>` block.

## Budget remaining
- Iterations: {{iteration}}/{{iterations_max}}
- Tokens: {{tokens_used}}/{{tokens_max}}
- Wall-clock: {{wallclock_minutes}}m / {{wallclock_max_minutes}}m
