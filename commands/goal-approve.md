---
description: "Manually issue GO for the current review-pending task"
argument-hint: "[--reason \"text\"]"
allowed-tools: ["Bash(${CLAUDE_PLUGIN_ROOT}/scripts/approve.sh:*)"]
---

# Goal Approve

The user invoked `/goal-approve` and may have specified a reason after `--reason`. Parse it from the user's message.

Run via Bash:

```bash
"${CLAUDE_PLUGIN_ROOT}/scripts/approve.sh" [--reason "<the parsed reason>"]
```

(Omit `--reason` if not given.) Print the script output to the user.
