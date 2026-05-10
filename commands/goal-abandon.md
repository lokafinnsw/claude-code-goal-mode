---
description: "Abandon the active goal (lifecycle → unmet with reason)"
argument-hint: "--reason \"...\""
allowed-tools: ["Bash(${CLAUDE_PLUGIN_ROOT}/scripts/abandon-goal.sh:*)"]
---

# Goal Abandon

The user invoked `/goal-abandon` and may have specified a reason after `--reason`. Parse it from the user's message.

Run via Bash:

```bash
"${CLAUDE_PLUGIN_ROOT}/scripts/abandon-goal.sh" [--reason "<the parsed reason>"]
```

(Omit `--reason` if not given.) Print the script output to the user.
