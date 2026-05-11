# Real Usage Findings — claude-code-goal-mode v1.1.8

Test environment: Darwin arm64 (Apple Silicon), Node v25.9.0, scratch dir `/tmp/goal-mode-real-test-1778418725`.
Date: 2026-05-10.

---

## Critical issues

### C1: install.sh dedup fires only when the path string contains the literal "goal-mode"

**Reproduction:** clone the repo to a path like `/home/alice/devtools/gm-plugin` (no "goal-mode" in the path), install once, install again.

The jq filter is:
```jq
.command // "" | contains("goal-mode") | not
```

If the repo was cloned to a path that does NOT contain the string `goal-mode`, prior hook entries are never removed and every re-run appends a new duplicate.

**Observed:** When the repo is at `/old/path/hooks/stop-hook.sh` (no "goal-mode" in path), running install.sh from the real repo path adds the new entry without removing the old one. Result after 3 installs: 5 Stop-hook entries — the 3 old plus 2 new.

**Verbatim (triplication scenario):**
```
=== Stop hooks count after dedup from 3 goal-mode hooks ===
5 Stop hook entries
  entry 0: CLAUDE_PLUGIN_ROOT=/old/path bash "/old/path/hooks/stop-hook.sh"
  entry 1: CLAUDE_PLUGIN_ROOT=/old/path bash "/old/path/hooks/stop-hook.sh"
  entry 2: CLAUDE_PLUGIN_ROOT=/old/path bash "/old/path/hooks/stop-hook.sh"
  entry 3: echo 'unrelated-hook'
  entry 4: CLAUDE_PLUGIN_ROOT=<new-path> bash "<new-path>/hooks/stop-hook.sh"
```

**Impact:** Every Claude Code stop event fires the hook N times, each consuming engine resources and potentially injecting N continuation prompts into the same session.

---

### C2: install.sh leaves a 0-byte orphaned `settings.json.new` when jq fails on malformed JSON

**Reproduction:** put malformed JSON in `~/.claude/settings.json` and run install.sh.

**Verbatim output:**
```
→ Copying 11 slash commands → .../fake-home-malformed/.claude/commands (with absolute-path substitution)
→ Backed up existing settings.json
jq: parse error: Unfinished JSON term at EOF at line 1, column 27
```
Exit code: 5 (raw jq exit). The script exits due to `set -euo pipefail`.

**Side effects observed:**
- `settings.json` is unchanged (original malformed content preserved — correct).
- `settings.json.bak-<ts>` exists (the backup of the malformed file — marginally useful).
- `settings.json.new` exists as a **0-byte file** (orphaned temp file from the `> settings.json.new` redirect that ran before jq failed).

**Impact:** (a) The user sees a raw `jq: parse error` with no explanation that their settings.json is invalid. (b) The orphaned .new file is confusing. (c) No guidance on how to fix the invalid JSON or recover.

---

## Important issues

### I1: `status-goal.sh` says "No active goal" when tree.json is corrupt but state.json is still valid

**Reproduction:** truncate `.claude/goals/active/tree.json` to partial JSON while a goal is active.

**Observed:**
```
$ bash status-goal.sh
No active goal. Run /goal:plan to start.
```

**What actually happened:** `loadTree()` silently renamed the corrupt file to `.broken-<ts>-0` and returned `null`. Since `renderStatusReport` gates on `tree && state`, a null tree triggers the "no active goal" path even though `state.json` is present and valid.

**Impact:** User loses visibility into their active goal state. The `.broken-*` file is their only clue, but the status command gives no hint that corruption occurred. A user who sees "No active goal" will likely try `/goal:plan` and overwrite their state, losing goal history.

**Files relevant:** `engine/render-status-cli.mjs` line 27 (`if (tree && state)`), `engine/state.mjs` `readWithBackup`.

---

### I2: `audit-verdict` status is case-sensitive — lowercase "go" or "nogo" is silently dropped

**Reproduction:** parse a transcript containing `<audit-verdict agent="security-reviewer" status="go">looks good</audit-verdict>`.

**Verbatim:**
```js
parseTags('<audit-verdict agent="security-reviewer" status="go">looks good</audit-verdict>')
// → []   (empty array — tag silently discarded)

parseTags('<audit-verdict agent="security-reviewer" status="GO">looks good</audit-verdict>')
// → [{"kind":"audit-verdict","agent":"security-reviewer","status":"GO","text":"looks good"}]
```

`VERDICT_VALUES` is `new Set(['GO', 'NOGO', 'REVISE'])`. The comment in `parse-tags.mjs` says "Missing or unknown `status`… on `<audit-verdict>`" is a silent skip — which matches the behavior — but the risk is that a real LLM will write lowercase since English capitalisation norms prefer "go" as a non-acronym.

**Impact:** The review loop stalls silently. The cursor stays on `review-pending`, `review_attempts` increments on the next Stop-hook fire, and after 3 cycles the goal escalates to `unmet`. The user gets no error message explaining why the review never resolved.

---

## Minor issues / polish

### M1: Inconsistent "no active goal" message casing between scripts

- `scripts/clear-goal.sh` (via `clear-cli.mjs`): `no active goal` (lowercase "n", no trailing period)
- `engine/render-status-cli.mjs`: `No active goal. Run /goal:plan to start.` (uppercase "N", with period)

Both are informational messages on stdout/stderr but different enough to confuse users comparing output across commands.

### M2: `approve-plan.sh` silently ignores all CLI arguments

Running `bash approve-plan.sh --dry-run` or `bash approve-plan.sh --bogus-arg` succeeds without any "unknown argument" warning. The CLI body in `approve-plan-cli.mjs` passes no args from `process.argv` to `approvePlan()`. A user who mistypes `--dry-run` thinking it does a preflight check gets a real approval instead.

### M3: Blank lines between criteria items in `continuation.md` output

The `{{#each criteria}}` template block ends each item with a newline, and the handlebars renderer produces double-newlines between items (one from the item's trailing `\n`, one from the block separator). This creates visible blank lines in the rendered checklist:

```
- [x] (#0) criterion zero

- [ ] (#1) criterion one

- [ ] (#2) criterion two
```

Cosmetically minor; readable but spacier than necessary.

### M4: `plan-bootstrap.md` writes 2 files; `plan-from-file.md` writes 3

`plan-bootstrap.md` (used by `/goal-plan`) instructs the LLM to write `plan.md` + `tree.json` (no `state.json`). `plan-from-file.md` writes all three including `state.json` with `lifecycle: "draft"`.

Both workflows are functionally correct: `approve-plan.sh` creates `state.json` if missing. But the asymmetry can confuse developers reading the prompts side-by-side, and LLM drift on the bootstrap path could leave a stale `state.json` from a prior goal if the user forgot to run `/goal-clear` first.

### M5: Unknown args to `start-goal.sh` are silently ignored

`start-goal-cli.mjs` consumes known flags (`--max-iter`, `--token-budget`, `--time-budget`, `--force`) and silently skips everything else. Running `/goal-start --dry-run` runs the real start with no warning.

### M6: `start-goal.sh` requires `CLAUDE_CODE_SESSION_ID` — exit code 2 but unclear message in context

When run from a terminal outside a Claude Code session, the user sees:
```
CLAUDE_CODE_SESSION_ID env var not set; this command must run inside a Claude Code session.
```
Exit code 2. Message is clear, but there is no help text pointing to how to use the command (e.g., "use /goal-start inside a Claude Code chat window").

### M7: `fix-cli-source.sh` has no `--help` flag

Unlike other scripts, there's no usage text. Minor since the script has a well-commented header.

---

## What works well (smoke pass)

- **Install.sh idempotency** when repo path contains "goal-mode": first run adds 1 entry, second run stays at 1 entry, permissions array stays deduplicated via `unique`. Old unrelated hooks (e.g. `echo 'some-other-hook'`) are preserved.
- **Fresh HOME install**: creates `~/.claude/`, `~/.claude/commands/`, `~/.claude/settings.json` from scratch without errors.
- **Full lifecycle transitions** all work: `approve → start → pause → resume → abandon`, `clear`, `clear --archive`.
- **Archive snapshot**: `clear-goal.sh --archive` creates a timestamped dir under `.claude/goals/archive/` containing `tree.json`, `state.json`, `plan.md`.
- **Stop-hook round-trip**: synthetic transcript with correct evidence tags advances cursor, review cycle fires and resolves, cursor advances to next task.
- **Budget-limit continuation**: when `iterations.used >= max`, returns correct `budget-limit.md` block with meaningful message; subsequent hook fires on the `budget-limited` lifecycle are silently suppressed.
- **Spaces in project path** (`/tmp/goal mode/with spaces/proj`): all scripts handle correctly via quoted paths.
- **Unicode in tree content** (Cyrillic + emoji in mission, titles, criteria): round-trips through `approve-plan → start → status` without corruption.
- **Symlink for `.claude/goals/active`**: all scripts follow the symlink transparently.
- **Corrupt-file recovery**: `readWithBackup` renames corrupt `tree.json` / `state.json` to `.broken-<ts>-<seq>` and returns `null`; no crash.
- **Empty state.json**: same recovery path as corrupt file.
- **Scripts from empty directory** (no `.claude` dir): all give "no active goal" or equivalent with exit 1.
- **`CLAUDE_PLUGIN_ROOT` unset (empty string)**: scripts fall back to deriving from `${BASH_SOURCE[0]}` location via `:${var:=default}` (colon-assign handles empty).
- **Wrong `CLAUDE_PLUGIN_ROOT`**: node gives a clear `Cannot find module` error (exit 1), no silent failure.
- **`node` missing from PATH**: all scripts exit 127 with clear `node: command not found` (install.sh pre-checks this).
- **Continuation prompt quality**: rendered `continuation.md`, `continuation-review.md`, `budget-limit.md`, `final-summary.md`, `unmet-summary.md` are all coherent, well-structured, and actionable from an LLM perspective.
- **`plan-from-file.md` prompt**: complete and actionable; includes schema example, acceptance-criteria synthesis rule, validate-command extraction, reviewer-availability handling.
- **`plan-bootstrap.md` prompt**: complete; includes stack-survey instruction, decomposition guide, acceptance-criteria quality rules.

---

## Untestable in this environment

- **Live Claude Code session**: slash-command discovery, `CLAUDE_CODE_SESSION_ID` propagation to the Stop hook, `$ARGUMENTS` expansion in `commands/goal-start.md` inline bash block, real permission prompt surfacing, actual LLM turn triggering the Stop hook.
- **Real token budget exhaustion**: `tallyTokens()` requires actual JSONL with `message.usage` fields containing `input_tokens` / `output_tokens` — all synthetic transcripts have `usage: undefined`, so `tallyTokens` returns 0. Token-budget limit cannot be triggered from synthetic transcripts.
- **Wallclock budget**: would require sleeping for the configured duration.
- **`subagent_type` availability discovery**: `discoverReviewers()` in `approve-plan-cli.mjs` reads `~/.claude/{skills,agents}/` and `<cwd>/.claude/{skills,agents}/`; only tested with the real global skills directory.
- **`fix-cli-source.sh` migration path**: the `git → github` migration was not tested with a real broken marketplace entry.

---

## Verbatim output samples

### approve-plan.sh (happy path, with unavailable reviewers)
```
⚠️  warnings:
  - node sprint-1.epic-1.task-1: reviewer "security-reviewer" not available in current environment
  - node sprint-1.epic-1.task-1: reviewer "js-reviewer" not available in current environment
  [... 8 more ...]
✅ plan approved (5 tasks)
```

### start-goal.sh (happy path)
```
🎯 Goal pursuing — cursor: sprint-1.epic-1.task-1, iter budget: 10, token budget: 100000, time budget: 300s
Stop-hook is now active. Make your first move on this task.
```

### status-goal.sh (pursuing, mid-run)
```
# 🎯 Goal: feature-auth-jwt — lifecycle: pursuing

## Plan tree
⬜ sprint-1 — Replace session-cookie auth with JWT
  ⬜ sprint-1.epic-1 — JWT issuance and verification
    ✅ sprint-1.epic-1.task-1 — Add jose dependency and create signing key configuration
    ⬜ sprint-1.epic-1.task-2 ◀ cursor — Implement signAccessToken and verifyAccessToken helpers
    ⬜ sprint-1.epic-1.task-3 — Wire requireAuth middleware onto protected routes
  ⬜ sprint-1.epic-2 — Refresh-token rotation and logout
    ⬜ sprint-1.epic-2.task-1 — Implement refresh-token rotation flow
    ⬜ sprint-1.epic-2.task-2 — Implement logout via refresh-token revocation list

## Budget
- Iterations: [████················] 2/10
- Tokens: [····················] 0/100000
- Wall-clock: [████················] 1/5 minutes

## Last 3 events
- 2026-05-10T13:14:54.229Z review-verdict sprint-1.epic-1.task-1
- 2026-05-10T13:14:54.229Z review-verdict sprint-1.epic-1.task-1
- 2026-05-10T13:14:54.229Z cursor-advanced sprint-1.epic-1.task-1
```

### stop-hook (budget exhausted)
Stop-hook stdout when `iterations.used >= max`:
```json
{
  "decision": "block",
  "systemMessage": "🟡 iterations budget exhausted",
  "reason": "# 🟡 Goal — budget exhausted (final turn)\n\nThe iterations budget for this goal has been reached:\n- Iterations: 2/2\n- Tokens: 0/100000\n- Wall-clock: 0m / 30m\n\nThis is your **final turn** for this goal. ..."
}
```

### install.sh on malformed settings.json
```
→ Copying 11 slash commands → .../fake-home-malformed/.claude/commands (...)
→ Backed up existing settings.json
jq: parse error: Unfinished JSON term at EOF at line 1, column 27
```
Exit 5. Leaves behind `settings.json.new` (0 bytes). Original `settings.json` is preserved. No user-friendly error.

### status-goal.sh on corrupt tree.json
```
No active goal. Run /goal:plan to start.
```
(This fires when `tree.json` is corrupt and has been renamed to `.broken-<ts>-0`. State.json still exists with lifecycle: budget-limited. The message is completely misleading.)

### audit-verdict case sensitivity
```
parseTags('<audit-verdict agent="x" status="go">ok</audit-verdict>')
→ []  ← silently dropped

parseTags('<audit-verdict agent="x" status="GO">ok</audit-verdict>')
→ [{"kind":"audit-verdict","agent":"x","status":"GO","text":"ok"}]
```
