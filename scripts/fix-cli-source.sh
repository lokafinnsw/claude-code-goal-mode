#!/usr/bin/env bash
# fix-cli-source.sh — auto-detect and repair the `"source": "git"` bug in
# Claude Code's user-global plugin marketplace registry.
#
# Background: when a user runs `/plugin marketplace add <full-https-URL>` in
# Claude Code 2.1.121-2.1.138, the CLI sometimes stores the marketplace as
# `{"source": "git", "url": "..."}` in:
#   ~/.claude/settings.json -> extraKnownMarketplaces.<name>.source
#   ~/.claude/plugins/known_marketplaces.json -> <name>.source
#
# `git` is accepted by the marketplace-add validator but rejected by the
# install switch (which only handles npm/github/url/git-subdir), so
# `/plugin install <plugin>@<marketplace>` fails with:
#   "This plugin uses a source type your Claude Code version does not support."
#
# This script migrates `git` -> `github` (with derived `repo`) for the
# goal-mode marketplace specifically. Idempotent: safe to re-run.
#
# Usage:
#   bash scripts/fix-cli-source.sh
#
# Or one-liner from anywhere:
#   bash <(curl -sL https://raw.githubusercontent.com/lokafinnsw/claude-code-goal-mode/main/scripts/fix-cli-source.sh)

set -euo pipefail

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  cat <<'HELP'
fix-cli-source.sh — auto-detect and repair the "source": "git" bug in
Claude Code 2.1.121-2.1.138's plugin marketplace registry.

Background:
  When users run /plugin marketplace add <full-https-URL> in Claude Code
  CLI, some versions store the marketplace as {"source": "git", ...} in
  ~/.claude/settings.json (extraKnownMarketplaces) and
  ~/.claude/plugins/known_marketplaces.json. The install handler accepts
  only npm/github/url/git-subdir, so /plugin install fails with
  "source type not supported".

Usage:
  bash scripts/fix-cli-source.sh         Apply the fix.
  bash scripts/fix-cli-source.sh --help  Show this help.

  Or one-liner from anywhere:
    bash <(curl -sL https://raw.githubusercontent.com/lokafinnsw/claude-code-goal-mode/main/scripts/fix-cli-source.sh)

What it does:
  - Scans ~/.claude/settings.json -> extraKnownMarketplaces.goal-mode.source
  - Scans ~/.claude/plugins/known_marketplaces.json -> goal-mode.source
  - If either has source="git", migrates to {source: "github", repo: "lokafinnsw/claude-code-goal-mode"}.
  - Writes a timestamped backup before each migration.
  - Idempotent: re-runs print "OK ... no change".
  - Touches only the goal-mode entry; other marketplaces preserved.

Exit codes:
  0  Success (with or without migrations).
  1  jq missing or unrecoverable error.

After the fix, reload Claude Code (or restart the session) and retry
  /plugin install goal-mode@goal-mode
HELP
  exit 0
fi

MARKETPLACE_NAME="goal-mode"
EXPECTED_REPO="lokafinnsw/claude-code-goal-mode"
SETTINGS="$HOME/.claude/settings.json"
KNOWN="$HOME/.claude/plugins/known_marketplaces.json"

if ! command -v jq >/dev/null 2>&1; then
  echo "ERROR: jq is required. Install with: brew install jq" >&2
  exit 1
fi

migrate_file() {
  local file="$1"
  local jq_path="$2"   # JQ path expression to the .source object
  if [[ ! -f "$file" ]]; then
    echo "SKIP: $file does not exist (no marketplace registered there yet)"
    return 0
  fi
  local current
  current=$(jq -r "$jq_path | .source // \"\"" "$file" 2>/dev/null || echo "")
  case "$current" in
    "git")
      echo "DETECTED: $file has source=\"git\" (broken). Migrating to \"github\"..."
      cp "$file" "$file.bak-fix-cli-source-$(date +%s)"
      jq --arg repo "$EXPECTED_REPO" \
         "$jq_path = {\"source\": \"github\", \"repo\": \$repo}" \
         "$file" > "$file.new"
      mv "$file.new" "$file"
      echo "  FIXED: $file"
      echo "  BACKUP: $file.bak-fix-cli-source-*"
      ;;
    "github"|"url"|"git-subdir"|"npm")
      echo "OK: $file already has source=\"$current\" (supported). No change."
      ;;
    "")
      echo "SKIP: $file has no $MARKETPLACE_NAME marketplace entry."
      ;;
    *)
      echo "WARN: $file has unexpected source=\"$current\". Manual review needed." >&2
      ;;
  esac
}

echo "=== fix-cli-source: scanning for goal-mode marketplace registrations ==="
migrate_file "$SETTINGS" ".extraKnownMarketplaces.\"$MARKETPLACE_NAME\".source"
migrate_file "$KNOWN" ".\"$MARKETPLACE_NAME\".source"

echo ""
echo "=== done ==="
echo ""
echo "If anything was migrated, reload Claude Code (or restart the session)"
echo "and retry: /plugin install $MARKETPLACE_NAME@$MARKETPLACE_NAME"
