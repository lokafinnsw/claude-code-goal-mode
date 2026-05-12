# Migration Guide: goal-mode v2.x → v3.0

**v3.0 is a workflow redesign, not a rewrite.** Your existing v2 state files load unchanged — no migration script, no schema bump, no breaking API changes. The only thing that changes is the default Stop-hook behaviour.

## TL;DR

| You want... | Do this |
|---|---|
| Latest v3 workflow (recommended) | `bash install.sh && restart Claude Desktop`. Stop-hook becomes hint-only. Drive goals via explicit CLI verbs. |
| Keep v2 driver behaviour | Same install, then add `.claude/goals/active/config.json` with `{"schema_version": 1, "stopHookDriver": true}` per project, OR `~/.claude/plugins/goal-mode/config.json` for all projects. |
| Verify which mode is active | `/goal-mode:goal-doctor` — look for the `legacy-stop-hook-driver` check (`ok` = v3 default, `warn` = legacy mode on). |

## What changes

### Behaviour

In v2, the Stop hook fired a continuation prompt every turn while `lifecycle === 'pursuing'`. The agent would emit XML tags like `<evidence>...</evidence>` and `<task-status>achieved</task-status>` in its reply, and the engine parsed those tags to advance state.

In v3, the Stop hook returns `null` stdout on `pursuing` by default. The agent drives the goal explicitly via slash commands:

| v2 tag | v3 slash command |
|---|---|
| `<evidence file="X" criterion="0" note="..."/>` | `/goal-mode:goal-evidence-add --criterion 0 --file X --note "..."` |
| `<task-status>achieved</task-status>` | `/goal-mode:goal-achieve` |
| `<review-request agents="X"/>` | `/goal-mode:goal-review-request` then `Agent({subagent_type: "X", ...})` |
| `<audit-verdict agent="X" status="GO">text</audit-verdict>` | `/goal-mode:goal-submit-verdict --agent X --status GO --text "text"` |

### Files

- All your existing `tree.json`, `state.json`, `events.jsonl`, `audits/*.json`, `notes.md` continue to work unchanged.
- Plan-tree schema, event log, reducer, lock protocol — all preserved.

## Recommended path: embrace v3 default

1. **Install v3.0:**
   ```bash
   cd /path/to/claude-code-goal-mode
   bash install.sh
   ```
2. **Restart Claude Desktop** (kill + relaunch).
3. **Verify v3 mode is active:**
   ```
   /goal-mode:goal-doctor
   ```
   Look for `legacy-stop-hook-driver: ok` and version `3.0.0`.
4. **Try the new workflow:**
   - `/goal-mode:goal-current` — see what you're on.
   - Do work in normal Claude Code mode.
   - `/goal-mode:goal-evidence-add --criterion 0 --file <path>:42 --note "..."`.
   - `/goal-mode:goal-achieve`.
   - If review-pending: `/goal-mode:goal-review-request`, dispatch reviewers, `/goal-mode:goal-submit-verdict`.

## Alternative path: keep v2 driver

If you depend on the v2 auto-drive workflow (Stop-hook injects continuation prompts, agent emits XML tags), opt in:

**Per project:**
```bash
mkdir -p .claude/goals/active
echo '{"schema_version": 1, "stopHookDriver": true}' > .claude/goals/active/config.json
```

**Per user (applies to all projects):**
```bash
mkdir -p ~/.claude/plugins/goal-mode
echo '{"schema_version": 1, "stopHookDriver": true}' > ~/.claude/plugins/goal-mode/config.json
```

Project config overrides user config when both are set.

Verify with `/goal-mode:goal-doctor` — `legacy-stop-hook-driver: warn` confirms legacy mode is on.

All v2 tag-emission semantics work as before:
- Tag parsing in `engine/parse-tags.mjs`
- Continuation prompt injection in `engine/stop-hook.mjs`
- Auto-pause-on-silence safety net (v2.0.6) still fires after 5 silent turns
- Reviewer-independence guard still enforced via `scannedAgents` Set

## Bridging to built-in /goal

Claude Code now has a built-in `/goal "<text>"` command with a Haiku-driven evaluator. You can combine it with goal-mode's structured tracker:

1. `/goal-mode:goal-current --as-builtin` — emits a single-line text fit for piping.
2. Copy the output and paste into a new `/goal "..."` invocation.
3. Built-in /goal handles the work loop.
4. After the work is done, manually run `/goal-mode:goal-evidence-add` and `/goal-mode:goal-achieve` to record progress in goal-mode's structured plan.

This gives you the best of both worlds: Anthropic's Haiku evaluator drives the loop; goal-mode tracks structure, reviewers, and budget.

## Codex / non-Claude-Code agents

For Codex `/goal` and other agents that can't invoke slash commands, the legacy tag-emission path is the only option. Set `stopHookDriver: true` and continue using `<evidence>`, `<task-status>`, `<audit-verdict>` tags as documented in `skills/goal-mode-tag-discipline/SKILL.md`.

## Rollback

If something breaks, you can downgrade to v2.0.6:

```bash
cd /path/to/claude-code-goal-mode
git checkout v2.0.6
bash install.sh
# Restart Claude Desktop
```

Your state files remain valid for v2.0.6 — no data loss.

## Questions

- **Will my existing goals break?** No. State files load unchanged.
- **Do I need to migrate tree.json or state.json?** No. Schema is unchanged (`schema_version: 2` continues).
- **Will tag emission stop working?** Only if you're in v3 default mode (no config.json). With `stopHookDriver: true`, all v2 tag semantics are preserved.
- **Can I run both v3 CLI verbs AND legacy tags?** Yes — the CLI verbs always work regardless of mode. Tags are parsed only when Stop-hook fires (legacy mode).
- **Does v3 auto-pause-on-silence still apply?** Only under `stopHookDriver: true`. In v3 default, there's no silence loop to detect because Stop-hook doesn't inject anything.
