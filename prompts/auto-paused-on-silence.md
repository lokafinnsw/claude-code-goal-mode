# ⏸ Goal auto-paused — controller agent stopped engaging

## Progress
```
{{progress_block}}
```

The engine has **auto-paused** the goal because the controller agent emitted **{{silent_turns}} consecutive turns with zero goal-mode tags** (no `<evidence>`, no `<task-status>`, no `<audit-verdict>`, no `<review-request>`). This is the v2.0.6 token-bleed safety net — without it, the Stop hook would keep firing the same continuation prompt every turn while the controller produces nothing actionable.

**Cursor was on:** task `{{task_id}}` ({{task_title}})

**Why this triggered (typical causes):**

1. A user-level memory rule told the controller agent not to engage with this goal in the current session (e.g., "Не лезь в игру"). The controller responded with minimum text per turn; engine detected the silent streak.
2. The controller is doing unrelated work in the same Claude Desktop session that's rooted in this project. Goal-mode Stop hooks fire per-project, not per-task-context.
3. The controller hit a state it can't address from code (environmental issue, missing files, network outage) and stopped emitting tags rather than fabricating progress.

**Recovery options:**

1. **`/goal-mode:goal-resume`** — resume work. Lifecycle returns to `pursuing` and the silent counter resets to 0. Use when the situation that caused silence is over (e.g., the user wants the agent back on the goal).
2. **`/goal-mode:goal-abandon --reason "..."`** — mark the goal `unmet`. Use when the goal is no longer wanted.
3. **`/goal-mode:goal-clear --archive`** — snapshot + remove the goal directory entirely. Use when starting over from a different mission.
4. **Open a separate Claude Desktop session** rooted in a different project — that session's Stop hooks won't see this goal. The current goal stays paused until you `/goal-mode:goal-resume`.

The engine will NOT fire Stop-hook continuations while paused. The auto-pause is fully reversible.

For full diagnostics: `/goal-mode:goal-doctor`.
