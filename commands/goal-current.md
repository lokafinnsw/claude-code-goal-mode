---
description: "Show cursor task, status, AC coverage (v3 read-only inspector)"
argument-hint: "[--json | --as-builtin]"
allowed-tools: ["Bash(${CLAUDE_PLUGIN_ROOT}/scripts/current.sh:*)"]
---

# Goal Current

Read-only inspector of the cursor task. Three output modes:
- (default) — human-readable multiline summary with `[x]`/`[ ]` checkboxes per AC.
- `--json` — full result as parseable JSON.
- `--as-builtin` — single-line text suitable for piping into Claude Code's built-in `/goal "..."`.

```
/goal-mode:goal-current
/goal-mode:goal-current --json
/goal-mode:goal-current --as-builtin
```

Parse user arguments from the message and dispatch:

```bash
"${CLAUDE_PLUGIN_ROOT}/scripts/current.sh" <parsed-args>
```

Print the script output.
