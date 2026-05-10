---
description: "Build a hierarchical plan tree (Sprint→Epic→Task) for the given mission"
argument-hint: "<mission text>"
allowed-tools: ["Read", "Glob", "Grep", "Bash(ls:*)", "Bash(cat:*)", "Bash(git log:*)", "Bash(git ls-files:*)", "Agent(Explore)", "Write"]
---

# Goal Plan

The user invoked `/goal-plan` followed by mission text. Extract the mission from the user's message (everything after `/goal-plan`).

Read the bootstrap instructions and follow them precisely. The instructions are at:

```bash
cat "${CLAUDE_PLUGIN_ROOT}/prompts/plan-bootstrap.md"
```

After you finish, both `.claude/goals/active/plan.md` and `.claude/goals/active/tree.json` must exist and reflect the same structure. Set `lifecycle="draft"` in `.claude/goals/active/state.json`. Write a minimal state.json with these fields (matching what `engine/state.mjs` `GoalStateSchema` requires):

```json
{
  "schema_version": 1,
  "goal_id": "<the slug you set on tree.goal_id>",
  "lifecycle": "draft",
  "cursor": "pending",
  "budget": {
    "iterations": { "used": 0, "max": 0 },
    "tokens": { "used": 0, "max": 0 },
    "wallclock": { "started_at": "<now ISO>", "max_seconds": 0 }
  },
  "session_id": "pending",
  "started_at": null,
  "paused_at": null,
  "ended_at": null,
  "ended_reason": null,
  "history": []
}
```

The `cursor` and `session_id` placeholders ("pending") will be replaced by real values when the user runs `/goal-start` (which sets them to the first pending task id and the Claude Code session id, respectively). `/goal-start` will populate budget caps and started_at; `/goal-approve-plan` will set `lifecycle="approved"`.
