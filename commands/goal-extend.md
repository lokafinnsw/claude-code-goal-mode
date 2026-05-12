---
description: "Bump budget limits on an active or budget-limited goal without re-planning"
argument-hint: "[--tokens +N|N[km]] [--iter +N|N] [--time +Nh|Nh|Nm|Nd]"
allowed-tools: ["Bash(${CLAUDE_PLUGIN_ROOT}/scripts/goal-extend.sh:*)"]
---

# Goal Extend

Bumps budget limits on the active goal. Use when the triple budget was hit before the goal completed and you want to continue rather than `/goal-clear` + re-plan from scratch (which would lose cursor, history, evidence, audits, and tree shape).

**Delta mode** (`+` prefix) — adds to current max:
```
/goal-mode:goal-extend --tokens +50M --time +4h
```

**Absolute mode** (bare value) — replaces current max:
```
/goal-mode:goal-extend --tokens 150M
```

Multiple dimensions in one call:
```
/goal-mode:goal-extend --tokens +50M --iter +1000 --time +2h
```

**Suffixes:**
- `tokens`: `k`=1000, `m`=1000000 (case-insensitive)
- `time`: `h`=hours, `m`=minutes, `d`=days, `s`=seconds (case-insensitive)
- `iter`: bare integer only

**Lifecycle:**
- `pursuing` → just bumps max, no transition.
- `budget-limited` → bumps max AND transitions back to `pursuing`. Stop-hook will then resume firing continuation prompts on the existing plan.
- Any other lifecycle (paused/achieved/unmet/draft/approved/awaiting-manual-approval) → rejected with `cannot extend budget from lifecycle=...`. Use the dedicated recovery path for those states.

**Validation:** new max must be ≥ already-consumed `used` count (cannot bump down past consumed budget).

Run via Bash:

```bash
"${CLAUDE_PLUGIN_ROOT}/scripts/goal-extend.sh" <parsed-args>
```
