---
description: "Build a hierarchical plan tree (Sprint→Epic→Task) for the given mission"
argument-hint: "<mission text>"
allowed-tools: ["Read", "Glob", "Grep", "Bash(ls:*)", "Bash(cat:*)", "Bash(git log:*)", "Bash(git ls-files:*)", "Agent(Explore)", "Write"]
---

# Goal Plan

The user wants to build a plan tree. Mission text:

$ARGUMENTS

Read the bootstrap instructions and follow them precisely. The instructions are at:

```!
cat "${CLAUDE_PLUGIN_ROOT}/prompts/plan-bootstrap.md"
```

After you finish, both `.claude/goals/active/plan.md` and `.claude/goals/active/tree.json` must exist and reflect the same structure. Set `lifecycle="draft"` in `.claude/goals/active/state.json` (write a minimal state.json with goal_id, schema_version, lifecycle:"draft", and zero budget — `/goal:start` will populate the rest).
