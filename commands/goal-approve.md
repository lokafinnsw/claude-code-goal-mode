---
description: "Manually issue GO for the current review-pending task"
argument-hint: "[--reason \"text\"]"
allowed-tools: ["Bash(${CLAUDE_PLUGIN_ROOT}/scripts/approve.sh:*)"]
---

# Goal Approve

```!
"${CLAUDE_PLUGIN_ROOT}/scripts/approve.sh" $ARGUMENTS
```
