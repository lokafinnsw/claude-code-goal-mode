#!/usr/bin/env bash
# install.sh — DEPRECATED as of v1.1.16. Kept for backward compat only.
#
# Background (May 2026 runtime probe finding):
#   Claude Desktop EMBEDS the same Claude Code binary used by the terminal
#   `claude` command (`~/Library/Application Support/Claude/claude-code/<ver>/`)
#   and uses the same plugin loader, the same `~/.claude/`, the same
#   settings.json. /plugin install works in BOTH Desktop and CLI.
#
# So install.sh's reason for existing — "Desktop can't /plugin install" — is
# false in May 2026. The single canonical install path is:
#
#     /plugin marketplace add https://github.com/lokafinnsw/claude-code-goal-mode
#     /plugin install goal-mode@goal-mode
#     /reload-plugins
#
# Running install.sh on top of /plugin install creates duplicate slash commands
# (e.g. /goal-status AND /goal-mode:goal-status both appear) and duplicate Stop
# hooks (settings.json hook + plugin auto-registered hook = double-fire and
# state mutation per Stop event).
#
# If you previously ran install.sh and want to clean up:
#
#     rm -f ~/.claude/commands/goal-*.md
#     jq '.hooks.Stop = [.hooks.Stop[] | select((.hooks // []) | map(.command // "" | (contains("goal-mode") or contains("claude-code-goal-mode"))) | any | not)]' ~/.claude/settings.json | sponge ~/.claude/settings.json
#
# This script still functions for users who want the install.sh path despite
# the warning (e.g. sandboxed environments without /plugin), but emits a
# deprecation notice and refuses to layer on top of an existing /plugin
# install (would create duplicates).

set -euo pipefail

# Deprecation warning + duplicate-guard.
echo "⚠️  install.sh is DEPRECATED as of v1.1.16."
echo "   Claude Desktop in May 2026 embeds Claude Code and supports /plugin install."
echo "   Use the canonical path instead:"
echo "       /plugin marketplace add https://github.com/lokafinnsw/claude-code-goal-mode"
echo "       /plugin install goal-mode@goal-mode"
echo "       /reload-plugins"
echo ""
if [[ -d "$HOME/.claude/plugins/cache/goal-mode/goal-mode" ]]; then
  echo "❌ Detected existing /plugin install at ~/.claude/plugins/cache/goal-mode/goal-mode/."
  echo "   Refusing to layer install.sh on top — would create duplicate slash commands"
  echo "   and double-firing Stop hooks. To use install.sh path exclusively, first run:"
  echo "       /plugin uninstall goal-mode@goal-mode"
  echo "       /plugin marketplace remove goal-mode"
  echo "   then re-run install.sh."
  exit 1
fi
echo "Continuing with install.sh in 5 seconds (Ctrl-C to abort)..."
sleep 5

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
