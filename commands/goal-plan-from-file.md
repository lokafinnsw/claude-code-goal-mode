---
description: "Convert an existing Markdown plan file into the goal-mode schema (tree.json + plan.md + draft state.json)"
argument-hint: "<path-to-plan.md>"
allowed-tools: ["Read", "Glob", "Grep", "Bash(ls:*)", "Bash(cat:*)", "Bash(git log:*)", "Bash(git ls-files:*)", "Agent(Explore)", "Write"]
---

# Goal Plan From File

The user invoked `/goal-plan-from-file` followed by a path to a Markdown plan file. Extract the path from the user's message (everything after `/goal-plan-from-file`).

Read the conversion instructions and follow them precisely:

```bash
cat "${CLAUDE_PLUGIN_ROOT}/prompts/plan-from-file.md"
```

Substitute `{{file_path}}` in the instructions with the user-provided path. Read the source file using the Read tool, parse its structure, and emit the three goal-mode files (`tree.json`, `plan.md`, `state.json`) into `.claude/goals/active/`.

Do NOT invent tasks the source does not mention. Do NOT drop tasks the source includes. The user wrote that plan deliberately.
