#!/usr/bin/env bash
# install.sh — install goal-mode for Claude Desktop / Claude Code via user-global config.
#
# What this does (idempotent):
#   1. Copy commands/goal-*.md → ~/.claude/commands/<name>.md, replacing
#      ${CLAUDE_PLUGIN_ROOT} with this repo's absolute path so the slash
#      commands resolve without a plugin loader.
#   2. Add the Stop hook to ~/.claude/settings.json (preserving existing
#      hooks/permissions/etc.). The hook command injects CLAUDE_PLUGIN_ROOT
#      so the engine's hooks/stop-hook.sh and CLI wrappers find their files.
#   3. Add permissions for the repo's scripts/*.sh and hooks/*.sh.
#
# Why not /plugin install? That's CLI-only (terminal app). Claude Desktop
# does not have /plugin install but DOES read ~/.claude/commands/ and
# ~/.claude/settings.json. This installer makes goal-mode work in both.
#
# Re-run this script after pulling new commits if commands/* changed.
#
# Uninstall:
#   rm ~/.claude/commands/goal-*.md
#   # And manually remove the Stop hook + Bash permissions from settings.json
#   # (or restore from the .bak created on first install).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMMANDS_DIR="$HOME/.claude/commands"
SETTINGS="$HOME/.claude/settings.json"

if [[ ! -f "$REPO_ROOT/.claude-plugin/plugin.json" ]]; then
  echo "❌ install.sh must be run from the goal-mode repo root (not found .claude-plugin/plugin.json)" >&2
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "❌ jq is required but not installed. brew install jq" >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "❌ node is required but not installed. Install Node 20+." >&2
  exit 1
fi

# 1. node_modules check (zod runtime dep).
if [[ ! -d "$REPO_ROOT/node_modules/zod" ]]; then
  echo "→ Installing npm dependencies (zod required by engine/state.mjs)..."
  (cd "$REPO_ROOT" && npm install --no-audit --no-fund)
fi

# 2. Copy commands with absolute-path substitution.
mkdir -p "$COMMANDS_DIR"
echo "→ Copying 11 slash commands → $COMMANDS_DIR (with absolute-path substitution)"
for f in "$REPO_ROOT"/commands/goal-*.md; do
  name=$(basename "$f")
  sed "s|\${CLAUDE_PLUGIN_ROOT}|$REPO_ROOT|g" "$f" > "$COMMANDS_DIR/$name"
done

# 3. Settings.json — add Stop hook + permissions (idempotent via jq).
if [[ ! -f "$SETTINGS" ]]; then
  echo '{}' > "$SETTINGS"
fi

# Preflight: validate existing settings.json is parseable. Raw jq parse error
# leaves an orphan .new file and shows cryptic output; better to fail clean.
if ! jq -e . "$SETTINGS" >/dev/null 2>&1; then
  echo "❌ ~/.claude/settings.json is not valid JSON. Refusing to clobber it." >&2
  echo "   Inspect with: jq . \"$SETTINGS\"" >&2
  echo "   Fix the parse error manually, then re-run install.sh." >&2
  exit 1
fi

# Cleanup any orphan .new file from a previously-failed run.
rm -f "$SETTINGS.new"
trap 'rm -f "$SETTINGS.new"' EXIT

cp "$SETTINGS" "$SETTINGS.bak-$(date +%s)"
echo "→ Backed up existing settings.json"

# MARKER: the Stop hook command embeds the literal string "# goal-mode-installer-managed"
# as a shell comment so the dedup filter can find prior installations regardless of
# the user's repo path. v1.1.10 and earlier matched on the substring "goal-mode" in
# the path, which broke for users who cloned to a directory whose name didn't contain
# "goal-mode" — re-running install.sh accumulated hook entries.
jq --arg root "$REPO_ROOT" '
  # Replace any existing goal-mode Stop hook (idempotent).
  #
  # Filter rule per Stop entry: KEEP if none of its hooks contain the marker.
  #
  # The naive form `(.hooks // [])[]?.command | contains(MARKER) | not`
  # produces ONE boolean PER hook in the entry (because `[]?` iterates).
  # `select(...)` then passes the entry through ONCE PER boolean — so an entry
  # with 3 unrelated hooks gets emitted 3 times. We collapse the multi-value
  # stream with `map(...) | any` so `select` runs exactly once per entry.
  .hooks = (.hooks // {}) |
  .hooks.Stop = (
    [(.hooks.Stop // [])[] | select(
      ((.hooks // []) | map(.command // "" | contains("# goal-mode-installer-managed")) | any) | not
    )] +
    [{
      "hooks": [{
        "type": "command",
        "command": ("CLAUDE_PLUGIN_ROOT=" + $root + " bash \"" + $root + "/hooks/stop-hook.sh\" # goal-mode-installer-managed")
      }]
    }]
  ) |
  # Add path-pinned permissions (idempotent via unique).
  .permissions = (.permissions // {}) |
  .permissions.allow = ((.permissions.allow // []) + [
    ("Bash(" + $root + "/scripts/*.sh:*)"),
    ("Bash(" + $root + "/hooks/*.sh:*)")
  ] | unique)
' "$SETTINGS" > "$SETTINGS.new"
mv "$SETTINGS.new" "$SETTINGS"

echo ""
echo "✅ goal-mode installed for Claude Desktop + Claude Code."
echo ""
echo "Next steps:"
echo "  1. Restart Claude Desktop (or reload the session) to pick up the new commands + Stop hook."
echo "  2. In any project where you want a goal: type /goal-help in Claude — should show all 11 commands."
echo "  3. To start a goal:"
echo "     - With existing markdown plan:  /goal-plan-from-file <path-to-plan.md>"
echo "     - From a free-form mission:     /goal-plan <mission text>"
echo "     - Then:                         /goal-approve-plan"
echo "     - Then:                         /goal-start --max-iter N --token-budget N --time-budget Nh"
echo ""
echo "Re-run this script after pulling new commits if commands/* changed."
