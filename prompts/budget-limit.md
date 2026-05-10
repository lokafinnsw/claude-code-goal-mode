# 🟡 Goal — budget exhausted (final turn)

The {{limit_kind}} budget for this goal has been reached:
- Iterations: {{iterations_used}}/{{iterations_max}}
- Tokens: {{tokens_used}}/{{tokens_max}}
- Wall-clock: {{wallclock_minutes}}m / {{wallclock_max_minutes}}m

This is your **final turn** for this goal. Do not attempt to continue work.

## What to do this turn

1. Append a progress summary to `.claude/goals/active/notes.md` titled `## Budget exhausted at iteration {{iterations_used}} ({{ts}})`. Include:
   - What is achieved (by sprint/epic/task id).
   - What is still pending or pursuing — for each, a 1-line "to resume, do X" hint.
   - What blockers remain unresolved.
2. **Do not** emit `<task-status>achieved</task-status>` for any task that is not actually finished. The engine will mark this run `budget-limited` regardless of what you claim.
3. Output the summary text to chat as well, so the user sees it.

After this turn, the engine will not invoke you again for this goal until `/goal-resume` (which requires fresh budget) or `/goal-clear`.
