---
description: "Start the active goal: lifecycle=pursuing, set budgets, cursor to first pending task"
argument-hint: "[--max-iter N] [--token-budget N] [--time-budget Nm|Nh]"
allowed-tools: ["Bash(${CLAUDE_PLUGIN_ROOT}/scripts/start-goal.sh:*)"]
---

# Goal Start

Run the engine setup:

```!
"${CLAUDE_PLUGIN_ROOT}/scripts/start-goal.sh" $ARGUMENTS
```

The Stop hook is now active. Begin work on the cursor task immediately.
