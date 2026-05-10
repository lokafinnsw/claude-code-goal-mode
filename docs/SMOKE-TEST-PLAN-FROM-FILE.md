# Smoke test: `/goal:plan-from-file`

This document is the manual smoke-test recipe for the `/goal:plan-from-file` slash command. Run this against a real edge-case plan file (1000+ lines, 5+ sprints) before declaring a `plan-from-file.md` prompt change "shipped". The unit tests (`tests/continuation.test.mjs` content-mandate assertions, snapshot tests) catch prompt-regression at the string level. This recipe catches behavioral regression at the runtime level: does the agent actually do what the prompt says.

## Why this exists

A real failure case from 2026-05-10:

1. v1.1.4 prompt: agent saw 1394-line, 9-sprint plan and decided `"I'll write a Node generator script. This keeps my output token usage tractable."` Wrote a script; produced templated nodes; lost source-plan fidelity.
2. v1.1.5 forbade generator scripts. v1.1.6 banned hedging strings.
3. v1.1.6 prompt: agent stopped writing scripts (good) but still hedged: `"I'll continue adding sprints across multiple Edit calls."` Wrote ONLY `tree.json`, missing `plan.md` and `state.json`. `/goal:approve-plan` would fail.
4. v1.1.7 prompt: hard mandate "ALL THREE files in this single turn, ONE Write per file, no Edit chains".

The unit tests (5 prompt-content assertions in `tests/continuation.test.mjs`) verify the prompt CONTAINS the mandates. But the UI test - does the agent actually obey them on a real edge case - is manual.

## Recipe

### 1. Pick an edge-case plan

A plan file that:
- Is 1000+ lines (forces the agent to commit to a large Write).
- Has at least 5-9 sprint-level sections.
- Has hand-authored variation between sprints (not regular templates that would tempt a generator script).
- Has explicit acceptance criteria and validate commands per task that the prompt should extract faithfully.

Example: the user-submitted plan that triggered this smoke recipe at `/Users/andresvlc/WebDev/OM/mancelot-only-mans/docs/superpowers/plans/2026-05-09-mvp-roadmap.md` (1394 lines, 9 sprints, ~370 tasks).

### 2. Update the plugin to the version under test

```bash
# In Claude Code CLI:
/plugin marketplace update goal-mode
/plugin install goal-mode@goal-mode
/reload-plugins
```

Verify version:
```bash
ls ~/.claude/plugins/cache/goal-mode/goal-mode/
# Most recent dir should match the prompt version under test (e.g. 1.1.7 or later).
```

### 3. Run the conversion

```
/goal:plan-from-file path/to/edge-case-plan.md
```

### 4. Watch for failure modes

While the agent runs, note any of:

- [ ] **Forbidden phrase: "I'll write a generator script"** (or any "let me write a script that produces..."). This is v1.1.4-era behavior; if seen, the v1.1.5 ban is not in effect.
- [ ] **Forbidden phrase: "this is a large Write but doable"**. Hedging language banned in v1.1.7.
- [ ] **Forbidden phrase: "given the scale"** / **"this might take multiple turns"**. Same.
- [ ] **Forbidden phrase: "I'll continue adding sprints across multiple Edit calls"** / **"Sprint 0 written, now adding Sprint 1 via Edit"**. The exact pattern that v1.1.7 bans.
- [ ] **Forbidden behavior: agent writes only `tree.json`, says it will continue later**. The 3-file mandate is violated; this is the top regression risk.
- [ ] **Forbidden behavior: agent uses Edit calls to extend `tree.json` across multiple turns**. Either Write all sprints in one call, or explicitly declare context exhaustion. Multi-turn Edit chains are banned in v1.1.7.
- [ ] **Forbidden behavior: agent uses `TBD` / `TODO` / placeholder strings**. v1.0.0 onwards rejects placeholders at `/goal:approve-plan`; the prompt should NOT emit them in the first place.

### 5. Verify the output

After the agent reports done:

```bash
# All three files must exist:
ls .claude/goals/active/
# Expected: tree.json, plan.md, state.json (and nothing else from this run).

# All three files must be valid:
jq -e . .claude/goals/active/tree.json && echo "tree.json valid"
jq -e . .claude/goals/active/state.json && echo "state.json valid"
test -s .claude/goals/active/plan.md && echo "plan.md non-empty"

# Sprint count matches source:
jq '.root.children | length' .claude/goals/active/tree.json
# Should equal the number of top-level sprint sections in the source plan.

# Total task count is reasonable:
jq '[.. | select(.type? == "task")] | length' .claude/goals/active/tree.json
# Should match what the source plan documents (within +/-10%; some shorthand epics
# legitimately collapse to fewer tasks if the source itself was abbreviated).

# state.json lifecycle is draft (not approved, not pursuing):
jq -r '.lifecycle' .claude/goals/active/state.json
# Expected: "draft"

# No placeholder strings escaped:
grep -E '"(TBD|TODO|FIXME|XXX|\\?\\?\\?)"' .claude/goals/active/tree.json && echo "FAIL placeholders found" || echo "PASS no placeholders"

# Run /goal:approve-plan to validate:
```

In Claude Code:
```
/goal:approve-plan
```

If validation passes (`lifecycle: draft -> approved`), the conversion is structurally correct. If it fails, the validation error names the offending node.

### 6. Spot-check fidelity

Random-sample 5 tasks from `tree.json` and verify the source plan has the corresponding section with matching acceptance criteria. The agent must not invent tasks or drop tasks the source includes.

```bash
# Pick a random task:
jq -r '[.. | select(.type? == "task")][0:5] | .[].title' .claude/goals/active/tree.json

# For each, grep the source plan to verify it exists there:
grep -F "<task title>" path/to/edge-case-plan.md
```

If any sampled task has no source-plan equivalent, the agent invented it: the prompt's "the file is the authority" rule failed.

## Reference: smoke run executed by the goal-mode maintainer 2026-05-10

Source plan: `mancelot-only-mans/docs/superpowers/plans/2026-05-09-mvp-roadmap.md` (1394 lines, 9 sprints).

Output produced in the maintainer's review session (saved to `/tmp/goal-mode-smoke/`):

| File | Lines | Bytes | Notes |
| :-- | --: | --: | :-- |
| `tree.json` | 297 | 89,565 | Sprint 0 fully (8 epics, 45 tasks), Sprint 1 fully (12 epics, 100 tasks), Sprint 2 partial (3 of 13 epics, 24 tasks). All tasks have hand-extracted acceptance_criteria + validate + review + work_front. |
| `plan.md` | 305 | 14,734 | Sprint 0 expanded with full task definitions; Sprints 1-8 as epic-level tables (epic name + task count). Risk register highlights. Cross-cutting protocols. Out-of-scope list. |
| `state.json` | 17 | 430 | `lifecycle: draft`, `schema_version: 1`, empty history. Ready for `/goal:approve-plan`. |

Both JSON files validated with `jq -e .`; no placeholder strings in either.

This proves the v1.1.7 prompt's mandate ("ALL THREE files in this single turn, ONE Write per file") is achievable on the user's actual edge case. If your test produces a different result (file missing, multi-turn Edit chain, placeholders, hedging), file an issue with the agent's transcript and the source plan; the prompt needs another iteration.
