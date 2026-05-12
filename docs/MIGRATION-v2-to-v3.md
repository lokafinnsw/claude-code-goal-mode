# Migration Guide: goal-mode v2.x → v3.0

**v3.0 is a workflow addition, not a rewrite.** Your existing v2 state files load unchanged — no migration script, no schema bump, no breaking API changes. v3 adds explicit CLI verbs as an alternative to tag emission; v3.0.4 keeps auto-drive (`stopHookDriver: true`) as the default so the out-of-the-box experience matches the original "set goal, walk away, come back" product value.

## TL;DR (v3.0.4)

| You want... | Do this |
|---|---|
| Default auto-drive (recommended for most) | `bash install.sh && restart Claude Desktop`. Stop-hook auto-drives. Tag emission OR CLI verbs both work. |
| Hint-only mode (no auto-drive; manual CLI drive) | Same install, then add `.claude/goals/active/config.json` with `{"schema_version": 1, "stopHookDriver": false}` per project, OR `~/.claude/plugins/goal-mode/config.json` for all projects. |
| Verify which mode is active | `/goal-mode:goal-doctor` — look for the `explicit-cli-mode` check (`ok` = auto-drive default, `warn` = hint-only opt-in is on). |

## What changes

### Behaviour

In v2, the Stop hook fired a continuation prompt every turn while `lifecycle === 'pursuing'`. The agent emitted XML tags like `<evidence>...</evidence>` and `<task-status>achieved</task-status>` in its reply, and the engine parsed those tags to advance state.

v3 keeps that auto-drive loop **on by default** (v3.0.4 restored this after a brief hint-only-default experiment in v3.0.0-v3.0.3) and **adds** explicit CLI verbs as an alternative. You can:

- Let Stop-hook drive (default) — agent emits tags as in v2, OR agent calls CLI verbs, both advance the cursor.
- Opt into hint-only mode (`stopHookDriver: false`) — Stop-hook returns `null` on `pursuing`; you must call CLI verbs to advance.

The v3 tag → CLI verb correspondence:

| v2 tag | v3 slash command |
|---|---|
| `<evidence file="X" criterion="0" note="..."/>` | `/goal-mode:goal-evidence-add --criterion 0 --file X --note "..."` |
| `<task-status>achieved</task-status>` | `/goal-mode:goal-achieve` |
| `<review-request agents="X"/>` | `/goal-mode:goal-review-request` then `Agent({subagent_type: "X", ...})` |
| `<audit-verdict agent="X" status="GO">text</audit-verdict>` | `/goal-mode:goal-submit-verdict --agent X --status GO --text "text"` |

### Files

- All your existing `tree.json`, `state.json`, `events.jsonl`, `audits/*.json`, `notes.md` continue to work unchanged.
- Plan-tree schema, event log, reducer, lock protocol — all preserved.

## Recommended path: keep default auto-drive

1. **Install v3.0.4:**
   ```bash
   cd /path/to/claude-code-goal-mode
   bash install.sh
   ```
2. **Restart Claude Desktop** (kill + relaunch).
3. **Verify auto-drive mode is active:**
   ```
   /goal-mode:goal-doctor
   ```
   Look for `explicit-cli-mode: ok` (auto-drive is default) and version `3.0.4`.
4. **Use either workflow:**
   - Auto-drive (legacy v2-style): agent emits tags `<evidence>`, `<task-status>`, `<audit-verdict>`; Stop-hook parses and advances cursor.
   - Explicit CLI (v3 additions, callable any time):
     - `/goal-mode:goal-current` — inspect cursor.
     - `/goal-mode:goal-evidence-add --criterion 0 --file <path>:42 --note "..."`.
     - `/goal-mode:goal-achieve`.
     - If review-pending: `/goal-mode:goal-review-request`, dispatch reviewers, `/goal-mode:goal-submit-verdict`.

## Alternative path: opt into hint-only mode

If you want to drive the cursor manually via CLI verbs only (no Stop-hook auto-drive) — e.g. you have a controller agent with memory rules forbidding goal-mode engagement — opt out of auto-drive:

**Per project:**
```bash
mkdir -p .claude/goals/active
echo '{"schema_version": 1, "stopHookDriver": false}' > .claude/goals/active/config.json
```

**Per user (applies to all projects):**
```bash
mkdir -p ~/.claude/plugins/goal-mode
echo '{"schema_version": 1, "stopHookDriver": false}' > ~/.claude/plugins/goal-mode/config.json
```

Project config overrides user config when both are set.

Verify with `/goal-mode:goal-doctor` — `explicit-cli-mode: warn` confirms hint-only mode is on.

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

For Codex `/goal` and other agents that can't invoke slash commands, the tag-emission path is the only option. The v3.0.4 default (`stopHookDriver: true`) already supports this — continue using `<evidence>`, `<task-status>`, `<audit-verdict>` tags as documented in `skills/goal-mode-tag-discipline/SKILL.md`.

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
- **Will tag emission stop working?** Tag emission keeps working in the v3.0.4 default (auto-drive). It only stops being parsed if you opt into hint-only mode (`stopHookDriver: false`), in which case you must drive via CLI verbs.
- **Can I run both v3 CLI verbs AND tags?** Yes — the CLI verbs always work regardless of mode. Tags are parsed only when Stop-hook auto-drives (the default).
- **Does auto-pause-on-silence still apply?** Yes — under `stopHookDriver: true` (the default), after 5 consecutive Stop-hook turns with zero engagement tags the goal auto-pauses with a recoverable reason. The stale-review-pending detector (v3.0.1) also still applies. Both safety nets continue to protect against runaway token spend.
