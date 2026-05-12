---
description: "Claim achievement on the cursor task (v3 explicit CLI)"
allowed-tools: ["Bash(${CLAUDE_PLUGIN_ROOT}/scripts/achieve.sh:*)"]
---

# Goal Achieve

Marks the cursor task achieved (if all ACs have evidence AND no reviewers required) OR transitions to `review-pending` (if reviewers required). Validates all acceptance criteria are covered before mutating.

```
/goal-mode:goal-achieve
```

No arguments. Run via Bash:

```bash
"${CLAUDE_PLUGIN_ROOT}/scripts/achieve.sh"
```

Print the script output to the user. Exit code semantics:
- 0: achieved (cursor advanced) or review-pending (reviewers listed).
- 1: missing-criteria (which) OR other precondition failure.
- 2: bad argument.
