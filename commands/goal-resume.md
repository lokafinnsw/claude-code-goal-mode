---
description: "Resume a paused goal (lifecycle paused → pursuing). For other states (pursuing/achieved/unmet/no goal) returns a distinct actionable message."
allowed-tools: ["Bash(${CLAUDE_PLUGIN_ROOT}/scripts/resume-goal.sh:*)"]
---

# Goal Resume

Resumes a paused goal. Distinct behaviour per lifecycle:

- `paused` — lifecycle → `pursuing`, Stop hook starts driving again.
- `pursuing` — already running. No resume needed.
- `achieved` / `unmet` / `budget-limited` — terminal. Clear and re-plan.
- no goal — points you at `/goal-mode:goal-plan-from-file` or `/goal-mode:goal-plan`.

```!
"${CLAUDE_PLUGIN_ROOT}/scripts/resume-goal.sh"
```
