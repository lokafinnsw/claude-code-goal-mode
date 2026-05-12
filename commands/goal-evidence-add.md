---
description: "Add evidence for a criterion on the cursor task (v3 explicit CLI)"
argument-hint: "--criterion N --file path[:line] --note \"...\" | --command \"cmd\" --exit-code N --note \"...\""
allowed-tools: ["Bash(${CLAUDE_PLUGIN_ROOT}/scripts/evidence-add.sh:*)"]
---

# Goal Evidence Add

Adds one evidence entry to the cursor task. Use this INSTEAD of emitting `<evidence/>` tags in the assistant reply when running in v3 default mode (hint-only Stop hook).

**File-based:**
```
/goal-mode:goal-evidence-add --criterion 0 --file src/foo.ts:42 --note "spec match"
```

**Shell-based:**
```
/goal-mode:goal-evidence-add --criterion 2 --command "npm test -- foo" --exit-code 0 --note "validation green"
```

The CLI enforces `lifecycle='pursuing'` and `cursor.status ∈ {pursuing, review-pending}`. Returns evidence count after the add.

Parse user arguments from the message and dispatch:

```bash
"${CLAUDE_PLUGIN_ROOT}/scripts/evidence-add.sh" <parsed-args>
```
