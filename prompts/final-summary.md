# ✅ Goal achieved — final summary turn

Every leaf task in this plan is now `achieved`. This is the final summary turn.

## What to do this turn

1. Append a closing block to `.claude/goals/active/notes.md`:
   ```
   ## Goal achieved at iteration {{iterations_used}} ({{ts}})

   - Sprints: {{sprint_count}}
   - Epics: {{epic_count}}
   - Tasks: {{task_count}}
   - Total iterations: {{iterations_used}}
   - Total tokens (best-effort): {{tokens_used}}
   - Wall-clock: {{wallclock_minutes}} minutes
   - Review verdicts collected: {{audit_count}}
   ```
2. List one-line per achieved task, grouped by sprint, with the most informative evidence note for each.
3. Output the same content to chat so the user sees it.

After this turn, the goal lifecycle is `achieved`. Run `/goal-clear --archive` to snapshot and reset.
