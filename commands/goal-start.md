---
description: "Start the active goal: lifecycle=pursuing, set budgets, cursor to first pending task"
argument-hint: "[--max-iter N] [--token-budget N] [--time-budget Nm|Nh]"
allowed-tools: ["Bash(${CLAUDE_PLUGIN_ROOT}/scripts/start-goal.sh:*)"]
---

# Goal Start

The user invoked `/goal-start` with possibly some flags after. Parse them from the user's message. Defaults if not given:

- `--max-iter` → `200`
- `--token-budget` → `5000000`
- `--time-budget` → `4h`
- `--force` → only if explicitly typed

Run via Bash (replace placeholders with parsed values):

```bash
"${CLAUDE_PLUGIN_ROOT}/scripts/start-goal.sh" --max-iter <N> --token-budget <N> --time-budget <Nh-or-Nm> [--force]
```

If the script returns `❌ goal already active (lifecycle=pursuing, ...); use --force to restart`, ask the user whether to restart with `--force` (warning: this clears progress).

The Stop hook is now active. Tell the user the cursor + budget summary the script printed, then begin work on the cursor task immediately.
