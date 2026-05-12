---
description: "Print reviewer dispatch template for a review-pending cursor (v3 explicit CLI)"
argument-hint: "[--json]"
allowed-tools: ["Bash(${CLAUDE_PLUGIN_ROOT}/scripts/review-request.sh:*)"]
---

# Goal Review Request

Read-only inspector. Prints the reviewer list, evidence summary, and audit-instructions template for the cursor task (which must be in `review-pending` after `/goal-mode:goal-achieve`).

```
/goal-mode:goal-review-request
/goal-mode:goal-review-request --json
```

Workflow after running this:
1. For each reviewer listed, dispatch via the Agent tool:
   ```
   Agent({
     subagent_type: "<reviewer>",
     description: "Review task <cursor-id>",
     prompt: "<audit-instructions template body>"
   })
   ```
2. Collect each verdict text.
3. Call `/goal-mode:goal-submit-verdict --agent <reviewer> --status GO|NOGO|REVISE --text "..."` for each.

Run via Bash:

```bash
"${CLAUDE_PLUGIN_ROOT}/scripts/review-request.sh" <args>
```

Print the script output to the user.
