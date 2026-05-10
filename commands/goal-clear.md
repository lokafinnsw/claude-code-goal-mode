---
description: "Clear the active goal directory (PERMANENT — pass --archive to snapshot before deletion)"
argument-hint: "[--archive]"
allowed-tools: ["Bash(${CLAUDE_PLUGIN_ROOT}/scripts/clear-goal.sh:*)"]
---

# Goal Clear

The user invoked `/goal-clear` and may have specified `--archive` to snapshot before deletion.

Run via Bash:

```bash
"${CLAUDE_PLUGIN_ROOT}/scripts/clear-goal.sh" [--archive]
```

(Omit `--archive` if not requested.) Print the script output to the user. If `--archive` was used, the archive path is printed.
