# 🔴 Goal — could not be completed (terminal: unmet)

The plan-tree could not be advanced past task **{{blocked_task_id}}** ("{{blocked_task_title}}"). After 3 consecutive review cycles or block iterations on the same node, the goal lifecycle was marked `unmet`.

**Blocking node:** {{blocked_task_id}}
**Blocker reason:** {{blocker_reason}}
**Review attempts:** {{review_attempts}}/3

## What this means

- The engine has stopped advancing the cursor and will not invoke you again for this goal until `/goal-clear` (which archives this run and clears `.claude/goals/active/`).
- The user can manually intervene via `/goal-approve` if they judge the work to be acceptable, or restructure the plan-tree and run `/goal-plan` to start a new attempt.
- This is NOT a bug in the engine. It is the engine refusing to declare success when the evidence does not support it. "Proxy-signal collapse" is the explicit failure mode being prevented.

## Final state

- Total iterations: {{iterations_used}}
- Total tokens (best-effort): {{tokens_used}}
- Wall-clock: {{wallclock_minutes}} minutes
- Tasks achieved: {{tasks_achieved}}/{{tasks_total}}

## What to do this turn

1. Append a closing block to `.claude/goals/active/notes.md`:
   ```
   ## Goal unmet at iteration {{iterations_used}} ({{ts}})

   - Blocked on: {{blocked_task_id}} — {{blocked_task_title}}
   - Reason: {{blocker_reason}}
   - Tasks achieved: {{tasks_achieved}}/{{tasks_total}}
   ```
2. Surface a 3–5 sentence summary to chat so the user understands the failure: which task blocked, what the blocker was, what they reviewed (cite verdicts if any), and whether the failure is recoverable (rewrite criteria, change reviewer, etc.) or terminal.
3. Do NOT emit `<task-status>achieved</task-status>` for any node. The engine has already terminated this run; emitting evidence will not restart it.

After this turn, run `/goal-clear --archive` to snapshot and reset.
