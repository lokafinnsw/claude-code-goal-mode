# Manual Smoke Test — claude-code-goal-mode

This recipe walks the `/goal:*` command surface end-to-end inside a real Claude Code session to verify the plugin works in the user's actual environment. The automated equivalent is at [tests/phase-5-e2e-smoke.test.mjs](../tests/phase-5-e2e-smoke.test.mjs); this manual recipe catches things the automated test cannot — Claude Code permission prompts, slash-command discovery, hook-stderr surfacing, real session-id propagation.

Run this whenever you ship a change that affects:
- `commands/goal-*.md` frontmatter or shell-escape body.
- `hooks/hooks.json` registration.
- `scripts/*.sh` shim invocation.
- `engine/*-cli.mjs` argv parsing.
- `engine/stop-hook.mjs` orchestrator side-effect ordering.

## Prereqs

- Node 20+ (or whatever `package.json` declares).
- Claude Code installed locally with the plugin loaded from this repo.
- A scratch project directory outside this repo (we'll use `/tmp/goal-smoke`).

## Recipe

### 1. Create a scratch project with a hand-crafted approved tree

```bash
mkdir -p /tmp/goal-smoke && cd /tmp/goal-smoke
git init  # ensures cwd looks like a project root
mkdir -p .claude/goals/active
cat > .claude/goals/active/tree.json <<'EOF'
{
  "schema_version": 1,
  "goal_id": "smoke",
  "mission": "Touch a file",
  "created_at": "2026-05-09T00:00:00.000Z",
  "approved_at": "2026-05-09T00:00:00.000Z",
  "root": {
    "id": "t",
    "type": "task",
    "title": "Create file foo.txt",
    "goal": "A file named foo.txt with text 'hi' exists.",
    "acceptance_criteria": ["foo.txt exists with content 'hi'"],
    "review": [],
    "validate": "test -f foo.txt && grep -q hi foo.txt",
    "work_front": null,
    "status": "pending",
    "evidence": [],
    "blocker_reason": null,
    "review_attempts": 0,
    "notes": [],
    "children": []
  }
}
EOF
```

The `approved_at` is set so `/goal-start` accepts the tree without going through `/goal-plan` (Phase 6).

### 2. Open Claude Code in the scratch project

```bash
cd /tmp/goal-smoke
claude
```

Claude Code should detect the plugin and load `commands/goal-*.md`. Verify with `/help` — the goal commands should be listed.

### 3. `/goal-status` BEFORE start

Run inside the Claude Code session:

```
/goal-status
```

**Expected:** `No active goal. Run /goal-plan to start.` (because no `state.json` exists yet).

### 4. `/goal-start --max-iter 5 --token-budget 100000 --time-budget 5m`

```
/goal-start --max-iter 5 --token-budget 100000 --time-budget 5m
```

**Expected stdout:**
```
🎯 Goal pursuing — cursor: t, iter budget: 5, token budget: 100000, time budget: 300s
Stop-hook is now active. Make your first move on this task.
```

Verify state file:
```bash
cat /tmp/goal-smoke/.claude/goals/active/state.json | head -20
```
Should show `lifecycle: "pursuing"`, `cursor: "t"`, `session_id: "<the-session-id>"`, single `started` history entry.

### 5. Drive Claude on the task

Tell Claude something like:
> Implement the task. Create foo.txt with content 'hi' and emit the evidence and task-status tags.

Claude should:
1. Run a shell command to create `foo.txt`.
2. Emit `<evidence file="foo.txt" criterion="0" note="..." />` and `<task-status>achieved</task-status>` in its response.
3. Stop. The Stop hook fires → engine processes the tags → renders `prompts/final-summary.md` → continuation prompt injected.
4. Claude sees the final-summary continuation and writes its closing turn.

### 6. `/goal-status` AFTER completion

```
/goal-status
```

**Expected:**
- `# 🎯 Goal: smoke — lifecycle: achieved`
- Tree showing `✅ t — Create file foo.txt` (with no `◀ cursor` since lifecycle is terminal).
- Budget bars showing 1-3 iterations consumed (depending on how many turns Claude took).
- Last 3 events including `evidence-added`, `cursor-advanced`, `achieved`.

### 7. Verify on disk

```bash
ls /tmp/goal-smoke/foo.txt           # exists
cat /tmp/goal-smoke/foo.txt          # 'hi'
cat /tmp/goal-smoke/.claude/goals/active/notes.md  # iteration digest entries
```

The `notes.md` should have one line per iteration ending in `lifecycle=achieved` for the final entry.

### 8. `/goal-clear --archive`

```
/goal-clear --archive
```

**Expected:**
```
📦 archived to /tmp/goal-smoke/.claude/goals/archive/<timestamp>-smoke
🧹 active goal cleared
```

Verify the archive contains `tree.json` + `state.json` and `.claude/goals/active/` is gone.

### 9. (Optional) Review-gate flow with `/goal-approve`

For tasks with non-empty `review[]`, the Stop hook puts the cursor into `review-pending` after the agent emits `<task-status>achieved</task-status>` + `<review-request agents="..." />`. From there, the agent is expected to invoke the named reviewer agents via the `Agent` tool, collect `<audit-verdict>` tags, and re-submit. If a required reviewer is unavailable in the user's environment, the user can manually override via `/goal-approve`.

#### Recipe variant: review-required task

Replace the tree.json's task definition with one that requires a review:

```bash
mkdir -p /tmp/goal-review-smoke && cd /tmp/goal-review-smoke
git init
mkdir -p .claude/goals/active
cat > .claude/goals/active/tree.json <<'EOF'
{
  "schema_version": 1,
  "goal_id": "review-smoke",
  "mission": "Touch a reviewable file",
  "created_at": "2026-05-09T00:00:00.000Z",
  "approved_at": "2026-05-09T00:00:00.000Z",
  "root": {
    "id": "t",
    "type": "task",
    "title": "Create file foo.txt with reviewer approval",
    "goal": "A file named foo.txt with content 'hi' exists, with art-director approval.",
    "acceptance_criteria": ["foo.txt exists with content 'hi'"],
    "review": ["aaa-art-director"],
    "validate": null,
    "work_front": null,
    "status": "pending",
    "evidence": [],
    "blocker_reason": null,
    "review_attempts": 0,
    "notes": [],
    "children": []
  }
}
EOF
```

Replace `aaa-art-director` with any reviewer subagent installed in your environment (check `~/.claude/agents/` and `~/.claude/skills/`). For testing without an installed reviewer, leave any name and use the manual `/goal-approve` path below.

#### `/goal-start` and observe review flow

Run `/goal-start --max-iter 10 --token-budget 200000 --time-budget 10m`, then prompt Claude to do the work. Claude should:

1. Create `foo.txt` and emit `<evidence file="foo.txt" criterion="0" note="..." />` + `<task-status>achieved</task-status>` + `<review-request agents="aaa-art-director" />`.
2. Stop hook fires → applyMutations transitions the cursor to `review-pending` → continuation prompt asks Claude to invoke the reviewer.
3. Claude calls `Agent({subagent_type: "aaa-art-director", ...})` (if installed) and emits `<audit-verdict agent="aaa-art-director" status="GO|NOGO|REVISE">...</audit-verdict>`.
4. Stop hook fires → applyMutations either advances cursor (all-GO) or returns to pursuing (any NOGO/REVISE). One audit JSON file is persisted per verdict.

#### Verify audit persistence

After at least one audit-verdict tag has been processed:

```bash
ls /tmp/goal-review-smoke/.claude/goals/active/audits/
# Expected: one or more files like `t-2026-05-XX-...-aaa-art-director.json`
cat /tmp/goal-review-smoke/.claude/goals/active/audits/*.json
# Expected JSON body: {ts, node_id, kind: "audit-verdict", agent, status, text}
```

#### Manual override: `/goal-approve --reason "..."`

If the reviewer subagent is not installed in your environment (or the agent emits a NOGO that you disagree with after manual inspection), use `/goal-approve`:

```
/goal-approve --reason "reviewer agent not installed in this environment"
```

**Expected:**
- Console: `✅ manually approved → cursor: <next-task-id>` (or `(last task — goal achieved)` if it was the final task).
- One new audit file in `audits/` named `<node>-<ts>-manual.json` with body `{...agent: "manual", status: "GO", manual: true, text: "..."}`.
- `state.cursor` advanced (or `state.lifecycle = "achieved"` if last task).
- `tree.root.children[0].status = "achieved"` (or whichever node was the cursor).

#### `/goal-approve` failure modes

`/goal-approve` refuses (exit 1) if:
- No active goal (`state.json` missing).
- `state.lifecycle != "pursuing"` (paused/achieved/unmet/budget-limited).
- Cursor node is not in `review-pending` status (e.g., still `pursuing` or already `achieved`).
- `state.cursor` doesn't match any node in the tree.

To test the review-pending refusal, run `/goal-approve` BEFORE the agent has emitted `<review-request agents="..." />` — expect `❌ cursor not review-pending (is pursuing)`.

### 10. (Optional) Pause / resume / abandon paths

Re-run steps 1-4 to set up a fresh goal, then:

**Pause:**
```
/goal-pause
```
Expected: `⏸ goal paused`. State `lifecycle: "paused"`, `paused_at` is set. Subsequent agent turns should NOT trigger continuation prompts (Stop hook silently exits).

**Resume:**
```
/goal-resume
```
Expected: `▶ goal resumed`. Lifecycle back to `pursuing`. Stop hook fires again on next turn.

Resume refuses if any budget is exhausted — to test, manually edit `state.json` to set `iterations.used = iterations.max` then run `/goal-resume`. Expected: `❌ budget exhausted; cannot resume`.

**Abandon:**
```
/goal-abandon --reason "switching strategies"
```
Expected: `⛔ goal abandoned: switching strategies`. Lifecycle becomes `unmet`. Stop hook silently exits (lifecycle gate).

`/goal-abandon` refuses on `achieved` or `unmet` lifecycles — to test, run twice in a row. Second call: `❌ cannot abandon from lifecycle=unmet`.

## Failure-mode checklist

If any of the following happen, STOP and investigate:

| Symptom | Likely cause | Where to look |
|---|---|---|
| `/goal-start` says `CLAUDE_CODE_SESSION_ID env var not set` | Plugin is invoked from a non-Claude-Code shell, OR Claude Code is not exporting the env var | `engine/start-goal-cli.mjs:28` (the I-3 fix-up gate); check `env \| grep CLAUDE_CODE` inside the slash-command shell context |
| Stop hook never fires (Claude completes a turn but no continuation appears) | session_id mismatch between `state.session_id` and the hook's stdin payload | `engine/stop-hook.mjs:106` (the session-id gate); compare `state.json.session_id` to `~/.claude/logs/*` hook payload logs |
| Stop hook fires but stdout is silent | Lifecycle is not `pursuing` (paused/achieved/unmet/budget-limited), OR an internal error was caught and logged to stderr | `~/.claude/logs/` for `[goal-mode]` lines from the I-3 stderr observability fix-up |
| Slash command not discovered (`/goal-status` errors as "unknown command") | Plugin not loaded, OR `commands/*.md` frontmatter malformed | `claude /plugins` to see loaded plugins; `cat commands/goal-status.md` to inspect frontmatter |
| `/goal-start` succeeds but next iteration's evidence tags do nothing | parseTags is stripping the agent's tags as code-fenced (the I-1 stripCodeRegions fix-up) | Verify the agent emits tags OUTSIDE backticks/fences in their response prose |
| Permission prompt appears for `Bash(${CLAUDE_PLUGIN_ROOT}/scripts/<x>.sh:*)` | First-time plugin use; Claude Code wants explicit user approval | Approve once; subsequent runs should not prompt unless permission scope changes |

## Versioning this recipe

When the plugin changes meaningfully (new command, breaking flag rename, frontmatter format change), update this file in the same commit. Stale recipes are worse than missing recipes — they imply correctness was checked when it wasn't.

The corresponding automated test at [tests/phase-5-e2e-smoke.test.mjs](../tests/phase-5-e2e-smoke.test.mjs) covers the engine surface; this manual recipe covers the Claude-Code-environment surface that the automated test cannot exercise (slash-command discovery, permission prompts, real session-id flow, hook stderr surfacing).
