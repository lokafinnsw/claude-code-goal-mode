# Changelog

All notable changes to claude-code-goal-mode are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.14] — 2026-05-10

### Added

- **`fix-cli-source.sh` now also enables `autoUpdate: true`** for the goal-mode marketplace in `~/.claude/plugins/known_marketplaces.json` (idempotent: no change if already true). With autoUpdate on, Claude Code pulls the latest goal-mode from GitHub at every session start — no manual `/plugin marketplace update goal-mode` per release. This is the same default that ships with `thedotmack/claude-mem` and other auto-tracked third-party marketplaces. (`scripts/fix-cli-source.sh`)
- **README "Auto-update" section** with the one-liner JQ recipe and the `bash <(curl -sL .../fix-cli-source.sh)` path for users who haven't cloned. (`README.md`)

### Notes

End-to-end smoke verified locally on a synthetic `~/.claude/plugins/known_marketplaces.json`:
- 1st run: detects MISSING autoUpdate, sets it to true, writes timestamped backup.
- 2nd run: detects true already, no change, no error.

The `autoUpdate` field is per-user and lives only in `~/.claude/plugins/known_marketplaces.json` — it cannot be shipped in the repo's `marketplace.json`. The `fix-cli-source.sh` migration is the deployment path; users who don't run it can use the `jq | sponge` one-liner from the README.

[1.1.14]: https://github.com/lokafinnsw/claude-code-goal-mode/releases/tag/v1.1.14

## [1.1.13] — 2026-05-10

Fixes the real Claude Desktop blocker: 6 commands using `$ARGUMENTS` shell expansion in their markdown were silently rejected by Desktop's slash-command parser (regardless of whether the user passed args), making `/goal-start`, `/goal-plan`, `/goal-plan-from-file`, `/goal-approve`, `/goal-abandon`, `/goal-clear` unusable in Desktop. v1.1.12 documented this as a Desktop limitation. v1.1.13 actually fixes it.

### Fixed

- **All 11 commands now work in both Claude Code CLI and Claude Desktop.** Root cause of the Desktop rejection: 6 of the command files (`commands/goal-start.md`, `goal-plan.md`, `goal-plan-from-file.md`, `goal-approve.md`, `goal-abandon.md`, `goal-clear.md`) used the `$ARGUMENTS` placeholder inside a `\`\`\`!` shell block. Claude Code CLI expands `$ARGUMENTS` before executing the block; Claude Desktop does not, and its parser rejects the whole command with "isn't a recognized command here" — even when the user types the command with no args. Fix: switch from `$ARGUMENTS`-substitution to a natural-language pattern. The command markdown now instructs the agent to parse the user's typed flags from their message and dispatch the underlying script via Bash with the parsed values. The agent does the parsing in either environment, so the same `/goal-start --max-iter 800` works identically in Desktop and CLI. (`commands/goal-start.md`, `commands/goal-plan.md`, `commands/goal-plan-from-file.md`, `commands/goal-approve.md`, `commands/goal-abandon.md`, `commands/goal-clear.md`)

### Changed

- **README "Claude Desktop limitations" section** rewritten to reflect that the limitation is gone in v1.1.13. The previous text said "no clean workaround"; that was true at the time given the v1.1.12 codebase, but the natural-language pattern in v1.1.13 IS the workaround. (`README.md`)

### Notes

End-to-end smoke verified locally on the maintainer's mancelot test target:
- All shim scripts (start-goal.sh, etc.) still accept the same `--flag` syntax — only the command-markdown layer changed. The agent now reads the user's message, parses flags, and invokes the script with explicit arguments via the Bash tool. This means CLI users keep their familiar `/goal-start --max-iter 800` UX, and Desktop users get the same flow without hitting the parser rejection.
- The 5 zero-arg commands (`goal-help`, `goal-status`, `goal-pause`, `goal-resume`, `goal-approve-plan`) still use the inline `\`\`\`!` shell-block pattern — no change there.
- Test count unchanged at 293; no test asserts on `$ARGUMENTS` literal in committed test files.

[1.1.13]: https://github.com/lokafinnsw/claude-code-goal-mode/releases/tag/v1.1.13

## [1.1.12] — 2026-05-10

Closes the M1-M7 tech-debt list from REAL-USAGE-FINDINGS plus a documented Claude Desktop limitation discovered when `/goal-start --max-iter ...` failed in Desktop with "isn't a recognized command here".

### Fixed

- **M1: Inconsistent "no active goal" casing.** `clear-cli.mjs` printed `no active goal` (lowercase, no period); `render-status-cli.mjs` printed `No active goal.` (capitalized). Lifecycle errors in `lifecycle-commands.mjs` and `manual-approve.mjs` also returned lowercase. Fix: all four code paths now return `No active goal.` (capitalized + period). Tests use `/no active goal/i` (case-insensitive) so no test changes needed. (`engine/clear-cli.mjs`, `engine/lifecycle-commands.mjs`, `engine/manual-approve.mjs`)

- **M2: `approve-plan-cli` silently accepted unknown args** (e.g., `--dry-run` was ignored without warning, leading users to think the flag worked). Fix: any non-empty arg list rejected with `Unknown arguments: <args>` + usage hint, exit 2. (`engine/approve-plan-cli.mjs`)

- **M5: `start-goal-cli` silently ignored unknown args.** Same pattern — typos like `--max-iters` (extra s) just got dropped, default kept. Fix: explicit `else` branch in arg loop rejects unknown args with usage hint, exit 2. (`engine/start-goal-cli.mjs`)

- **M2 + M5 also applied to `clear-cli.mjs`, `abandon-cli.mjs`, `approve-cli.mjs`** for consistency. Each rejects unknown args with usage hint.

- **M6: `start-goal-cli` env-var-missing error did not hint at the cause.** When `CLAUDE_CODE_SESSION_ID` was unset, the message said only "this command must run inside a Claude Code session" — but the most common cause is a user running it from Claude Desktop, where the env var is never set because Desktop has no plugin loader. Fix: error now explicitly says "the terminal app, not Claude Desktop" + reference to the new README "Claude Desktop limitations" section. (`engine/start-goal-cli.mjs`)

- **M3: Continuation prompts (continuation.md, continuation-blocked.md, audit-instructions.md) emitted blank lines between Mustache `{{#each}}` items.** Each iteration produced `\n- item\n`, but the `{{#each}}` tag itself was on its own line ending with `\n`, so the rendered output had an extra blank line before AND after the loop body. Lists looked spacey. Fix: inline the `{{#each}}` tag with the first content line so the loop body emits items contiguously. Verified: 2-item criteria render as `- a\n- b\n`, no blank lines between. Snapshot tests regenerated. (`prompts/continuation.md`, `prompts/continuation-blocked.md`, `prompts/audit-instructions.md`, `tests/__snapshots__/continuation.test.mjs.snap`)

- **M4: `plan-bootstrap.md` mandated only 2 output files (tree.json + plan.md), while `plan-from-file.md` mandated 3 (tree.json + plan.md + state.json).** This asymmetry meant `/goal-plan` left the user without a `state.json`, so `/goal-approve-plan` had to synthesize one — and the user's manual edit window between plan and approve had no consistent state shape to reason about. Fix: plan-bootstrap.md now mandates all 3 files in this single turn (matching plan-from-file.md), with the same minimal-draft state.json shape (lifecycle: draft, cursor: pending, history: []). (`prompts/plan-bootstrap.md`)

- **M7: `fix-cli-source.sh --help` was missing.** Users running the script without context saw it act on `~/.claude/` immediately (with backups, but still surprising). Fix: `--help` and `-h` now print background, usage, what-it-does, and exit codes; main script body unchanged when no help flag. (`scripts/fix-cli-source.sh`)

### Added — Claude Desktop limitations (documentation)

- **README "Claude Desktop limitations" section** between Installation and Switching paths. Documents two limits versus Claude Code CLI:
  1. `$ARGUMENTS` is CLI-only. Slash commands taking arguments (`/goal-start`, `/goal-plan`, `/goal-plan-from-file`, `/goal-approve --reason`, `/goal-abandon --reason`, `/goal-clear --archive`) emit "isn't a recognized command here" in Desktop. Run from CLI instead.
  2. Zero-arg commands (`/goal-help`, `/goal-status`, `/goal-pause`, `/goal-resume`, `/goal-approve-plan`) work in both.

  The recommended workflow if a user primarily uses Desktop: run `/goal-plan` and `/goal-start` once from CLI to bootstrap the active goal, then drive the Stop-hook loop from Desktop with no further argument-bearing commands needed.

  This is a Claude Desktop limitation, not a goal-mode bug. Documented so a future user hitting the same `/goal-start` rejection in Desktop has a clear answer + workaround. (`README.md`)

### Notes

`engine/lifecycle-commands.mjs` returns `{ ok: false, error: 'No active goal.' }` (capitalized + period). The two-call sites in `engine/clear-cli.mjs` (the `noop` branch) and `engine/render-status-cli.mjs` already used the capitalized form. Test count unchanged at 293; only snapshots updated.

End-to-end smoke verification of all 7 M-fixes done locally:
- M2: `bash scripts/approve-plan.sh --dry-run` → `Unknown arguments: --dry-run\nUsage: /goal-approve-plan (no arguments)` (was: silent acceptance).
- M5: `bash scripts/start-goal.sh --bogus` → `Unknown argument: --bogus\nUsage: /goal-start [...]` (was: silent acceptance, default kept).
- M6: `bash scripts/start-goal.sh` (no env var) → 3-line error with Desktop hint (was: 1 line, no Desktop reference).
- M7: `bash scripts/fix-cli-source.sh --help` → multi-line help block + exit 0 (was: no flag, ran on $HOME immediately).
- M3: rendered continuation.md shows `- [ ] (#0) a\n- [x] (#1) b\n\n## Already...` (no blank line between criteria items; one blank line before next section, which is normal markdown).

[1.1.12]: https://github.com/lokafinnsw/claude-code-goal-mode/releases/tag/v1.1.12

## [1.1.11] — 2026-05-10

Fixes 4 bugs uncovered by REAL-USAGE-FINDINGS testing (synthetic-fixture run on Darwin arm64, Node 25.9.0). Two Critical, two Important; +5 regression tests.

### Fixed

- **Critical C1: `install.sh` Stop-hook dedup matched on the literal substring "goal-mode" in the repo path**, so users who cloned to a directory whose name did NOT contain "goal-mode" (e.g. `~/devtools/gm-plugin/`) would accumulate Stop-hook entries on every re-run of install.sh. After 3 re-runs that user had 3 duplicated goal-mode entries plus the unrelated ones — every Claude Stop event ran the goal-mode hook 3 times, runaway resource consumption. Fix: inject literal marker comment `# goal-mode-installer-managed` into the hook command string and dedup by marker (path-independent). Bash treats `#` as comment, so the marker has no runtime effect. (`install.sh`)

- **Critical C2: `install.sh` against malformed `~/.claude/settings.json` left an orphan `settings.json.new` file (0 bytes) and exited with raw jq parse error** — no user-facing explanation that the existing settings was the problem, no cleanup, no remediation hint. Fix: preflight `jq -e .` validation BEFORE the transform; if it fails, print actionable error ("Inspect with: jq . $SETTINGS  # to see the parse error location") and exit 1. Add `trap 'rm -f "$SETTINGS.new"' EXIT` to clean up orphan files even on unexpected failures. (`install.sh`)

- **Important I1: `/goal-status` reported "No active goal" when `tree.json` was corrupt but `state.json` was intact** — `loadTree()` renamed corrupt tree to `.broken-<ts>-<seq>` and returned null, falling through to the no-goal message. Tempted user to run `/goal-plan` which OVERWRITES state.json, destroying surviving history. This is a destroy-data path. Fix: new branch in `renderStatusReport` for partial corruption — surfaces "corrupt state" warning, lists forensic copies (up to 3 + count), prints lifecycle/goal_id of preserved state, gives explicit recovery steps, ends with "Do NOT run /goal-plan or /goal-start until tree.json is restored." (`engine/render-status-cli.mjs`)

- **Important I2: `<audit-verdict status="go">` (lowercase) silently dropped** — `VERDICT_VALUES = new Set(['GO', 'NOGO', 'REVISE'])` did strict-case lookup, so real-world LLM lowercase output never registered. Review loop hung; after 3 NOGO iterations the engine escalated lifecycle to "unmet" without a real reason. Fix: `(attrs.status ?? '').toUpperCase()` before Set lookup. Lowercase, mixed-case, and `Revise`/`go`/`nogo` all parse correctly and are stored uppercase in the canonical output. (`engine/parse-tags.mjs`)

- **README staleness: status badge hardcoded `1.0.0` while package.json was at 1.1.10**, failing T1a/T1b doc-staleness regression tests. Fix: switched to dynamic shields.io badge `https://img.shields.io/github/v/tag/lokafinnsw/claude-code-goal-mode?label=release&color=brightgreen` that auto-tracks the latest GitHub tag. No more manual badge bumps per release. (`README.md`)

### Added

- **5 regression tests** locking the I1 + I2 fixes:
  - `tests/parse-tags.test.mjs`: `accepts lowercase verdict status`, `drops audit-verdict with empty status`. Asserts lowercase `go`/`nogo`/`Revise` produce uppercase `GO`/`NOGO`/`REVISE` in canonical output.
  - `tests/render-status-cli.test.mjs`: 3 new tests covering tree-corrupt-state-intact, state-corrupt-tree-intact, and only-forensic-copies-remain branches. Each asserts the warning surfaces and the dangerous "No active goal" message is NOT emitted.
  - Test count: 288 → 293.

### Notes

C1 and C2 are bash-script bugs, end-to-end verified locally:
- C1: synthetic `/tmp/install-tests/gm-plugin/` (no "goal-mode" in path), 2 install.sh runs against settings.json with 2 unrelated Stop hooks. Result: 3 entries after run 1, still 3 after run 2 (idempotent).
- C2: synthetic `{ "hooks": { broken` settings.json. Result: clean error message, no orphan .new file, settings.json untouched.

I1 and I2 are JS bugs, locked by the new regression tests above.

[1.1.11]: https://github.com/lokafinnsw/claude-code-goal-mode/releases/tag/v1.1.11

## [1.1.10] — 2026-05-10

### Fixed

- **`install.sh` "Next steps" echo block still printed `/goal:X` syntax.** The bulk replace in v1.1.9 hit `prompts/`, `commands/`, `README.md`, `docs/` but missed `install.sh` itself. After re-running `bash install.sh` post-1.1.9, users would see "type /goal:help in Claude" — but `/goal:help` does not exist; the working command is `/goal-help`. Fix: replaced 5 references to `/goal:X` in install.sh's echo block with `/goal-X`. (`install.sh`)

### Notes

End-to-end smoke verification was performed by the maintainer:

1. `bash install.sh` redeploys 11 commands to `~/.claude/commands/goal-X.md` with `${CLAUDE_PLUGIN_ROOT}` substituted to absolute paths.
2. `unset CLAUDE_PLUGIN_ROOT && bash scripts/approve-plan.sh` (simulating Claude Desktop's invocation, since Desktop has no plugin loader to set the env var) succeeds with `✅ plan approved (304 tasks)` instead of crashing with `unbound variable`. The defensive default in v1.1.9 derives `CLAUDE_PLUGIN_ROOT` from `BASH_SOURCE`.

Side effect of step 2: the test target was the maintainer's local `mancelot-only-mans/.claude/goals/active/tree.json`, so this run actually advanced its lifecycle from `draft` to `approved` and created `state.json` with the approval history event. The fix verified, but the test target now has an approved (partial, 3-sprint) plan instead of a draft. Users running similar smoke tests should target a throwaway goal directory or expect lifecycle advancement as a real side effect of the script working.

[1.1.10]: https://github.com/lokafinnsw/claude-code-goal-mode/releases/tag/v1.1.10

## [1.1.9] — 2026-05-10

### Fixed

- **`CLAUDE_PLUGIN_ROOT: unbound variable` crash in all 8 shim scripts when run from Claude Desktop.** Real failure case from the wild: user clicked `/goal-approve-plan` in Desktop, install.sh-deployed `~/.claude/commands/goal-approve-plan.md` invoked `/Users/.../scripts/approve-plan.sh`, the shim said `node "${CLAUDE_PLUGIN_ROOT}/engine/approve-plan-cli.mjs"` and crashed. Root cause: Claude Code CLI's plugin loader sets `CLAUDE_PLUGIN_ROOT` env var when invoking plugin commands; Claude Desktop has no plugin loader so the env var is unset; the script's `set -u` then explodes. Fix: each of the 8 shims (`abandon-goal.sh`, `approve-plan.sh`, `approve.sh`, `clear-goal.sh`, `pause-goal.sh`, `resume-goal.sh`, `start-goal.sh`, `status-goal.sh`) and the `hooks/stop-hook.sh` now have a defensive default that derives `CLAUDE_PLUGIN_ROOT` from `BASH_SOURCE` if the env var is unset: `: "${CLAUDE_PLUGIN_ROOT:=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"`. CLI mode: env var stays as set by loader, default ignored. Desktop mode: derives from script's own location (always `<plugin-root>/scripts/X.sh` so `dirname/..` resolves to plugin-root). Verified: all 8 shims now succeed (showing functional "no active goal" messages) when invoked without `CLAUDE_PLUGIN_ROOT`. (`scripts/*.sh`, `hooks/stop-hook.sh`)

- **`/goal:X` slash-command syntax was wrong everywhere; should be `/goal-X`.** Real failure case from the wild: agent (running per `prompts/budget-limit.md`, `prompts/final-summary.md`, etc.) suggested user run `/goal:start --max-iter 200 --token-budget 2500000`. Both Claude Desktop and Claude Code CLI rejected this with "Unknown command: /goal-start. Did you mean /goal-start?" — the colon syntax does not exist as a user-facing slash command in either environment; commands are accessed by the `.md` filename (`commands/goal-X.md` → `/goal-X`). Fix: bulk replace `/goal:X` → `/goal-X` across all user-facing content (`prompts/`, `commands/`, `README.md`, `docs/`). 155 references migrated. CHANGELOG kept verbatim for historical accuracy. (`prompts/*.md`, `commands/*.md`, `README.md`, `docs/*.md`, snapshot test files updated)

### Notes

The two bugs were independent but both surfaced in the same Desktop test run. v1.1.5-1.1.8 only tested the Claude Code CLI install path; the Desktop install.sh path was untested end-to-end. The user explicitly requested smoke testing in v1.1.8, then ran one against Desktop and exposed both bugs at once. The lesson: every release should smoke both Path A (CLI plugin install) and Path B (install.sh + Claude Desktop) before shipping.

[1.1.9]: https://github.com/lokafinnsw/claude-code-goal-mode/releases/tag/v1.1.9

## [1.1.8] — 2026-05-10

### Added

- **`docs/SMOKE-TEST-PLAN-FROM-FILE.md`** — manual smoke-test recipe for `/goal:plan-from-file` against an edge-case plan. Covers: pick a 1000+ line plan, update plugin to version under test, run conversion, watch for forbidden phrases (full list with v1.1.4 → v1.1.5 → v1.1.6 → v1.1.7 regression history), verify all three files exist + are valid + are non-placeholder, run `/goal:approve-plan` as the structural check, spot-check fidelity by sampling 5 tasks against the source plan. Includes a reference smoke run executed against the user's 1394-line, 9-sprint Mancelot MVP plan (Sprint 0 fully, Sprint 1 fully, Sprint 2 partial; tree.json 297 lines, plan.md 305 lines, state.json 17 lines, both JSONs valid). The unit tests at `tests/continuation.test.mjs` catch prompt-regression at the string level; this recipe catches behavioral regression at the runtime level. (`docs/SMOKE-TEST-PLAN-FROM-FILE.md`)

### Notes

The smoke recipe was added in response to user feedback after a real failure case. Even with v1.1.7's hard mandates, the user's local plugin cache was still running v1.1.4 - the agent showed v1.1.4-era behavior because the version had not been pulled. This recipe makes it explicit that step 2 of the smoke is "update the plugin first", and step 4 is "watch for these specific forbidden phrases", so a reviewer running the smoke catches "your local cache is stale" before blaming the prompt. It also documents the maintainer's reference run as a comparison anchor.

[1.1.8]: https://github.com/lokafinnsw/claude-code-goal-mode/releases/tag/v1.1.8

## [1.1.7] — 2026-05-10

### Fixed

- **`/goal:plan-from-file` agent skipped two of three required output files and split `tree.json` across multi-turn Edit chains.** Real failure case from the wild on a 1394-line, 9-sprint plan: agent wrote only `.claude/goals/active/tree.json` (84KB, well-formed Sprint 0 + Sprint 1, ~44 + ~50 tasks each). It did NOT write `.claude/goals/active/plan.md` or `.claude/goals/active/state.json` (both required by the spec). It also said "Sprint 0 written, now adding Sprint 1 via Edit. I'll continue adding sprints across multiple Edit calls" — picking the slow iterative path when ONE Write per file would have completed the conversion. After the run, `/goal:approve-plan` would have failed (incomplete state, missing files). Fix: `prompts/plan-from-file.md` Hard Rule #2 now mandates ALL THREE files in this single turn (one Write per file, three Writes total, no Edit chains), bans the new specific hedging phrases ("I'll continue adding sprints across multiple Edit calls", "Sprint 0 written, now adding Sprint 1 via Edit"), and clarifies the multi-turn fallback: only declare context exhaustion explicitly, never silently leave the file in a state where `/goal:approve-plan` would fail. (`prompts/plan-from-file.md`, `tests/__snapshots__/continuation.test.mjs.snap`)

### Added

- **5 prompt-content smoke assertions in `tests/continuation.test.mjs`** so a future weakening edit fails LOUD instead of degrading silently. Asserts the prompt mandates all three files, forbids generator scripts, forbids multi-turn Edit chains and exact hedging strings ("this is a large Write but doable", "I'll continue adding sprints across multiple Edit calls", "Sprint 0 written, now adding Sprint 1 via Edit"), mandates "ONE Write per file / Three Writes total", and forbids leaving the file in a state where approve-plan fails. Test count: 283 → 288. (`tests/continuation.test.mjs`)

### Notes

This is a behavioral mandate test, not just a green CI signal. It was added in response to user feedback: "не просто прогнать, что тесты зеленые, а нормальную проверку — smoke! чтобы отловить все косяки!" The smoke covers: regression on the prompt's behavioral contract.

[1.1.7]: https://github.com/lokafinnsw/claude-code-goal-mode/releases/tag/v1.1.7

## [1.1.6] — 2026-05-10

### Added

- **`scripts/fix-cli-source.sh`** — auto-detect-and-migrate script for the `"source": "git"` bug in Claude Code 2.1.121-2.1.138's plugin marketplace registry. Scans `~/.claude/settings.json` (`extraKnownMarketplaces.goal-mode.source`) and `~/.claude/plugins/known_marketplaces.json` (`goal-mode.source`); if either has `"source": "git"`, replaces with `{"source": "github", "repo": "lokafinnsw/claude-code-goal-mode"}` and timestamps a backup. Idempotent: re-running on already-migrated files prints "OK ... no change". Touches only the goal-mode entry; other marketplaces preserved. (`scripts/fix-cli-source.sh`)
- **README troubleshooting one-liner**: `bash <(curl -sL https://raw.githubusercontent.com/lokafinnsw/claude-code-goal-mode/main/scripts/fix-cli-source.sh)` for users hit by the bug who haven't cloned the repo. (`README.md`)

### Fixed

- **`prompts/plan-from-file.md` Hard Rule #2 strengthened with explicit forbidden phrases.** Real failure case from the wild: after the 1.1.4 anti-generator-script fix, the agent stopped writing generators but still hedged ("I'll write tree.json directly. Given the scale (~470 tasks), this is a large Write but doable."). The user reads "doable" as "the agent isn't sure". Fix: prompt now lists forbidden hedging phrases by exact wording ("this is a large Write but doable", "let me write a generator", "given the scale...", "I'll start with a few tasks and continue", "this might take multiple turns") and mandates: "Just emit the Write calls." Also clarifies multi-turn fallback (Edit to extend, never replace tasks with TBD placeholders). (`prompts/plan-from-file.md`, `tests/__snapshots__/continuation.test.mjs.snap`)

### Notes

The `git`-vs-`github`-source-type mismatch is a Claude Code CLI bug. README troubleshooting documented the manual fix in 1.1.3, but a manual edit is friction. v1.1.6 ships an auto-fix script. Once Anthropic patches the validator/installer mismatch upstream, this script can be deprecated.

[1.1.6]: https://github.com/lokafinnsw/claude-code-goal-mode/releases/tag/v1.1.6

## [1.1.5] — 2026-05-10

### Fixed

- **`install.sh` jq filter triplicated existing Stop hooks.** Real failure case from a fresh install: user had one Stop entry containing 3 unrelated hooks (cmux-notify, landing-the-plane, audit-on-completion). After running install.sh, settings.json had FOUR Stop entries — the original got triplicated and the goal-mode entry was appended. Reason: the filter `(.hooks // [])[]?.command | contains("goal-mode") | not` produces ONE boolean PER hook in the entry (because `[]?` iterates the inner hooks array), and `select(...)` then passes the entry through ONCE PER boolean. With 3 unrelated hooks, the entry passed through `select` 3 times. Fix: collapse the multi-value stream into a single boolean via `((.hooks // []) | map(.command // "" | contains("goal-mode")) | any) | not`. Verified: idempotent across N runs, edge cases pass (empty Stop array, missing hooks key, existing goal-mode entry replaced regardless of `CLAUDE_PLUGIN_ROOT` path). Inline comment in install.sh documents why the naive form is wrong. (`install.sh`)

### Recovery for users hit by the bug in 1.1.0–1.1.4

If you ran `bash install.sh` from one of those versions and your `~/.claude/settings.json` now has multiple identical Stop entries:

```bash
# Inspect:
jq '.hooks.Stop | length' ~/.claude/settings.json   # >1 with same hooks = corrupted

# Restore from the timestamped backup install.sh created on first install:
ls -1t ~/.claude/settings.json.bak-* | head -1   # most-recent pre-install state
# Inspect that backup, then if it looks correct:
cp <backup-path> ~/.claude/settings.json

# Re-run install.sh from this 1.1.5+ release:
bash install.sh
```

[1.1.5]: https://github.com/lokafinnsw/claude-code-goal-mode/releases/tag/v1.1.5

## [1.1.4] — 2026-05-10

### Added

- **README "Usage" section** between Installation and Status. End-to-end recipes for both entry paths (`/goal:plan` from scratch, `/goal:plan-from-file` from existing Markdown), then "while pursuing" (`/goal:status`, `/goal:pause`, `/goal:resume`), review gates with manual override, stopping (`/goal:abandon`, `/goal:clear`), state-file map, and a tag reference for the engine's parser. Emphasizes the structural-defense semantic: engine refuses to advance unless every acceptance criterion has at least one mapped `<evidence>` tag. (`README.md`)

### Fixed

- **`/goal:plan-from-file` agent shortcut: writing a generator script instead of emitting `tree.json` + `plan.md` directly.** Real failure case from the wild: agent saw a 1394-line, 17-sprint, 61-task source plan and decided "I'll write a Node generator script to produce the schema, this keeps my output token usage tractable." The script approach loses fidelity (every node becomes templated, not faithful to the source's hand-authored nuance per section). Fix: `prompts/plan-from-file.md` now has an explicit Hard Rule #2 forbidding generator scripts and naming the cure: emit the schema directly via the Write tool, even if the result is 100KB+; large outputs are the cost of the task, not a reason to shortcut. Rule #1 also strengthened: read every line / heading / table / callout, page through 2000+ line files. (`prompts/plan-from-file.md`, `tests/__snapshots__/continuation.test.mjs.snap`)

### Notes

The "writes a generator script" anti-pattern is a real cost-optimization failure mode for any LLM-driven schema-conversion task where the source is large. Documenting the anti-pattern in the prompt itself (as a Hard Rule, not a hint) is the cure.

[1.1.4]: https://github.com/lokafinnsw/claude-code-goal-mode/releases/tag/v1.1.4

## [1.1.3] — 2026-05-10

### Fixed

- **`marketplace.json` plugin source switched from `url` (with sha pin) to `url` (no sha)**. The pinned-sha form locked installs to the v1.1.2 commit forever, so users could never receive `/plugin marketplace update` improvements. Dropping the sha lets the plugin loader pull the latest `main` on every marketplace update — at the cost of pinning, gained "this is the same workflow `claude-plugins-official` plugins use." (`marketplace.json`)

### Documentation

- **README "Installation" rewrite**. Explicit Path A (CLI) vs Path B (Desktop) sections, with a "pick one — don't run both" warning (running both registers the Stop hook twice and the engine double-mutates state). Added "Switching between paths" with the two cleanup recipes. (`README.md`)
- **README "Troubleshooting" section added**. Documents the `git` vs `github` source-type pitfall in `~/.claude/settings.json` → `extraKnownMarketplaces`: when a user runs `/plugin marketplace add <https-URL-with-.git-suffix>`, some Claude Code 2.1.x versions store the marketplace as `"source": "git"`, which the installer rejects with "source type not supported" even though `marketplace add` accepts it. The fix is a manual edit to `"source": "github"` + `"repo"`. Also documents the unrelated-hook-error noise users may see (e.g. `claude-mem` `zod/v3` missing) and how to silence it. (`README.md`)

### Notes

The `git`-vs-`github`-source mismatch is a real bug in Claude Code 2.1.121–2.1.138 — the marketplace-add validator accepts `["github","git","url","settings"]` but the install switch only handles `["npm","github","url","git-subdir"]`. Reported via in-CLI testing on 2026-05-10.

[1.1.3]: https://github.com/lokafinnsw/claude-code-goal-mode/releases/tag/v1.1.3

## [1.1.2] — 2026-05-10

### Fixed

- **`/plugin install goal-mode@goal-mode` failed with "This plugin uses a source type your Claude Code version does not support"**. Root cause: `marketplace.json` had `"source": "."` — a self-referential string source that the May 2026 Claude Code marketplace schema does not accept. Per the official schema (https://code.claude.com/docs/en/plugin-marketplaces), valid sources are either a relative subdirectory string (`"./plugins/foo"`) OR an object like `{"source": "github", "repo": "owner/repo"}`. Fix: switched to GitHub source. The plugin loader now clones from https://github.com/lokafinnsw/claude-code-goal-mode at install time. (`marketplace.json`)

- **Vendored `node_modules/zod`** to make the plugin self-contained. Claude Code does not run `npm install` when cloning a plugin into `~/.claude/plugins/cache/`, but `engine/state.mjs` imports `zod` at runtime — so without vendoring the engine would crash on first Stop hook invocation with `Cannot find module 'zod'`. Other deps (vitest, etc.) remain `.gitignore`'d as they're devDependencies. Adds ~5 MB / 596 files to the repo, but eliminates a class of post-install failures and makes `/plugin install` work cleanly. (`.gitignore`, `node_modules/zod/`)

### Notes

This release un-breaks the Claude Code CLI install path that 1.0.0–1.1.1 had silently broken (the marketplace schema required objects-or-subdirs since some earlier Claude Code release). Existing users who installed via `install.sh` (Claude Desktop path) are unaffected.

To re-install after this fix:

```
/plugin marketplace update goal-mode  # if you previously added it
# or, fresh:
/plugin marketplace add https://github.com/lokafinnsw/claude-code-goal-mode
/plugin install goal-mode@goal-mode
```

[1.1.2]: https://github.com/lokafinnsw/claude-code-goal-mode/releases/tag/v1.1.2

## [1.1.1] — 2026-05-10

### Added

- **`install.sh`** — idempotent installer for Claude Desktop and any environment where `/plugin install` is unavailable. Reads the repo path, copies `commands/goal-*.md` to `~/.claude/commands/` with `${CLAUDE_PLUGIN_ROOT}` substituted to absolute paths, registers the Stop hook in `~/.claude/settings.json` with `CLAUDE_PLUGIN_ROOT` env injection, adds path-pinned Bash permissions for the repo's `scripts/*.sh` and `hooks/*.sh`. Backs up existing `settings.json` to `.bak-<ts>` on first run. Re-run after `git pull` to refresh commands. Preserves any existing non-goal-mode Stop hooks (idempotent `jq` filter on `goal-mode` substring in command).
- **README "Installation" section** — split into "Claude Code CLI" path (`/plugin install`) and "Claude Desktop / when `/plugin` isn't available" path (`bash install.sh`). Documents what `install.sh` does, where state lives, and uninstall.

### Why

`/plugin install goal-mode` only works in Claude Code CLI (terminal app). Claude Desktop and other Claude environments cannot use `/plugin marketplace add`, but they DO read `~/.claude/commands/` for slash commands and `~/.claude/settings.json` for hooks. `install.sh` makes goal-mode work in both worlds via the same user-global config Claude Desktop already honors.

[1.1.1]: https://github.com/lokafinnsw/claude-code-goal-mode/releases/tag/v1.1.1

## [1.1.0] — 2026-05-10

### Added

- **`/goal:plan-from-file <path>`** — new slash command for users who already have a Markdown plan written. The LLM reads the user's source file (any layout — H2/H3/H4 hierarchy, flat bullet lists, mixed conventions), maps it to the Sprint → Epic → Task schema, extracts acceptance criteria and validate commands from the source where present (synthesizes from task title/goal where absent — every task must have ≥1 criterion to satisfy the engine's schema), and writes `tree.json` + normalized `plan.md` + draft `state.json` into `.claude/goals/active/`. Composes cleanly with `/goal:approve-plan` → `/goal:start` (no engine changes — the existing `validatePlan` validates the converted tree, and the existing lifecycle gates accept it). (`commands/goal-plan-from-file.md`, `prompts/plan-from-file.md`)

### Changed

- **README + `/goal:help`**: 11 slash commands instead of 10 (added `/goal:plan-from-file`); refreshed Commands table with the new entry.
- **`docs/PLAN-FORMAT.md` + Commands table**: `/goal:plan <mission>` is now described as "build from scratch (LLM bootstrap)" to distinguish from `/goal:plan-from-file <path>` ("convert from existing Markdown").

### Notes

This is the natural complement to `/goal:plan`: `/goal:plan` asks the LLM to design the plan; `/goal:plan-from-file` asks the LLM to translate the user's pre-written plan into the engine's schema. The `validatePlan` business-rule layer (Phase 6) catches placeholder strings (`TBD`, `TODO`, etc.) the user's source may have left in — fix them between `/goal:plan-from-file` and `/goal:approve-plan`.

Test count post-1.1.0: 282 → 283 committed across 24 files (+1 snapshot test for `prompts/plan-from-file.md`).

[1.1.0]: https://github.com/lokafinnsw/claude-code-goal-mode/releases/tag/v1.1.0

## [1.0.1] — 2026-05-10

### Fixed

- **Bug A (Important)** — `/goal:start` after `/goal:approve-plan` now succeeds without `--force`. The Phase 5.1 hardening M-2 gate ("refuse double-startGoal without --force") was too aggressive — it refused even the canonical post-approval workflow, since `approvePlan` writes a `lifecycle="approved"` state to record the `plan-approved` history event. Fix limits M-2 refusal to non-restartable lifecycles (`pursuing`, `paused`, `achieved`, `unmet`, `budget-limited`); `draft` and `approved` now restart without `--force`. M-2 protection preserved for mid-flight and terminal states. (`engine/start-goal.mjs`)

- **Bug B (Minor latent)** — `safeFilenamePart` (twin in `engine/apply-mutations.mjs` and `engine/manual-approve.mjs`) now collapses runs of 2+ dots to `_`. Previously `..` survived sanitization because `.` was in the allowed character set for filename extensions. No exploit path existed in 1.0.0 (`node_id`/`agent` is always embedded in a larger token), but defense-in-depth against future code paths that may use the sanitized string as a path component.

### Discovered via

User-driven adversarial testing (`tests/adversarial-phases-5-8.test.mjs`, 80 hostile tests covering Phases 5-8 — local-only dev tracker, not in CI). 5 regression tests added to committed test files: 3 in `tests/start-goal.test.mjs` (Bug A acceptance + M-2 preservation), 1 each in `tests/apply-mutations.test.mjs` and `tests/manual-approve.test.mjs` (Bug B traversal-attempt sanitization).

Test count post-fix: 277 → 282 committed tests across 24 files.

[1.0.1]: https://github.com/lokafinnsw/claude-code-goal-mode/releases/tag/v1.0.1

## [1.0.0] — 2026-05-10

### Added

Initial stable release. The first complete plan-tree goal mode for Claude Code.

**Engine** (10 modules):
- `engine/state.mjs` — zod schemas for the plan-tree, runtime state, history events, and triple budget; atomic on-disk persistence with `.broken-<ts>-<seq>.json` corrupt-file forensic copies.
- `engine/paths.mjs` — path helpers for `.claude/goals/active/`, `.claude/goals/archive/`.
- `engine/traversal.mjs` — pre-order DFS over the plan-tree, leaf-task walker, cursor advancement.
- `engine/continuation.mjs` — pure Mustache-subset renderer with arbitrary nesting + `buildContext` for prompt rendering + `TemplateRenderError` typed error class.
- `engine/parse-tags.mjs` — pure parser for the documented tag set (`<evidence>`, `<task-status>`, `<review-request>`, `<audit-verdict>`, `<blocker>`).
- `engine/apply-mutations.mjs` — pure mutation engine: evidence accumulation → criteria-coverage check → cursor advance → review-pending lifecycle → 3-cycle blocked-escalation → terminal `achieved`/`unmet` lifecycle transitions; optional audit-verdict JSON persistence.
- `engine/transcript.mjs` — TOCTOU-safe JSONL session-transcript reader.
- `engine/stop-hook.mjs` — runtime orchestrator composing every prior module; lifecycle gates, code-region stripping before tag parsing, audit persistence, terminal-template rendering.
- `engine/budget.mjs` — `tallyTokens` from session JSONL + `checkLimits` triple-budget check.
- `engine/wallclock.mjs` — shared `wallclockMinutes` helper with NaN-clamp and injectable `now`.

Plus 8 CLI wrappers (`engine/*-cli.mjs`) for the slash commands (one wrapper covers `/goal:pause` + `/goal:resume`), all guarded by `import.meta.url ===` for testability.

**Prompts** (8 templates) in `prompts/`:
- `continuation.md` — pursuing-turn default.
- `continuation-review.md` — review-pending turn.
- `continuation-blocked.md` — blocked-task turn.
- `budget-limit.md` — graceful exit on budget exhaustion.
- `final-summary.md` — goal-achieved final turn.
- `unmet-summary.md` — goal-unmet terminal turn (deviation from plan; closes a UX gap).
- `audit-instructions.md` — body injected into reviewer `Agent()` calls.
- `plan-bootstrap.md` — instructs Claude to build the plan-tree on `/goal:plan`.

**Slash commands** (10) in `commands/` + `scripts/` shims:
- `/goal:plan <mission>` — bootstrap a plan-tree.
- `/goal:approve-plan` — validate + lock plan; lifecycle `draft → approved`.
- `/goal:start [--max-iter N] [--token-budget N] [--time-budget Nm|Nh] [--force]` — begin pursuing.
- `/goal:status` — render plan-tree, cursor, budget bars, last events; archive-discovery fallback when no active goal.
- `/goal:pause` / `/goal:resume` — halt / resume; resume refuses on budget exhaustion.
- `/goal:approve [--reason "..."]` — manual review override when subagent unavailable.
- `/goal:abandon --reason "..."` — terminal `unmet`; refuses on already-terminal lifecycles.
- `/goal:clear [--archive]` — remove active dir; optional unique-timestamp archive.
- `/goal:help` — comprehensive command list + mental model + lifecycle states + budget primer + state files + anti-patterns.

**Documentation** in `docs/`:
- `PLAN-FORMAT.md`, `REVIEW-AGENTS.md`, `BUDGET.md`, `ANTI-PATTERNS.md`, `SMOKE-TEST.md`.
- `EXAMPLES/` — three sample plans (Python migration, Node JWT auth, JS refactor) with corresponding tree.json files; all round-trip through `validatePlan`.

**Test suite**: 277 unit + integration + E2E tests across 24 files (verified via `npx vitest run --exclude 'tests/adversarial*.mjs'`). Per-phase E2E suites prove cross-module wiring (Phase 3 parser→mutator, Phase 4 multi-iteration state persistence, Phase 5 lifecycle journey, Phase 6 plan-flow, Phase 7 audit-gate, Phase 8 multi-turn budget, Phase 10 example-plan validation). CI green per commit.

### Notes

This release implements all 10 phases of the original design:
- Phases 0–4: foundation (skeleton, state, renderer, parser/mutator, Stop-hook orchestrator).
- Phases 5–7: user-facing surface (slash commands, plan bootstrap, audit gate).
- Phase 8: budget enforcement (tally + 3-axis exhaustion).
- Phase 9: discoverability (`/goal:help`, status archive-discovery).
- Phase 10: docs + examples + 1.0.0 tag.

Two design choices documented as known limitations (defer to post-1.0.0):
- `tallyTokens` excludes `cache_read_input_tokens` (under-counts billing on cache-heavy sessions; documented in `docs/BUDGET.md`).
- Archive *recovery* (`.broken-<ts>-<seq>.json` forensic-copy restore, archive→active copy-back) is discovery-only; no `/goal:restore` command yet.

[1.0.0]: https://github.com/lokafinnsw/claude-code-goal-mode/releases/tag/v1.0.0
