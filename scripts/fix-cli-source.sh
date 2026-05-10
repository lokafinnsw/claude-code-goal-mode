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
