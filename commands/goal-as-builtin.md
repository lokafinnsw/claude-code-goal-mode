---
description: "Emit cursor task as text suitable for piping into Claude Code's built-in /goal (v3 bridge)"
allowed-tools: ["Bash(${CLAUDE_PLUGIN_ROOT}/scripts/as-builtin.sh:*)"]
---

# Goal As-Builtin

Prints the current cursor task as a single-line text that can be piped into Claude Code's built-in `/goal "<text>"` command. The built-in goal evaluator (Anthropic Haiku) then drives the loop while goal-mode tracks structure, reviewers, and budget.

```
/goal-mode:goal-as-builtin
```

Workflow:
1. Run this command to get the text.
2. Copy the output.
3. Paste into a new `/goal "..."` invocation.
4. Built-in /goal handles the work loop; use `/goal-mode:goal-evidence-add`, `/goal-mode:goal-achieve`, etc. to record progress in the structured tracker.

```bash
"${CLAUDE_PLUGIN_ROOT}/scripts/as-builtin.sh"
```

Print the output to the user verbatim (it's already formatted for /goal).
