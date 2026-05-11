#!/usr/bin/env bash
# install.sh — install goal-mode WITHOUT a terminal `/plugin install`.
#
# Why this exists: in Claude Desktop, `/plugin install`, `/plugin marketplace
# add`, and `/reload-plugins` are CLI-only slash commands (`type: "local-jsx"`
# in the embedded Claude Code binary, rejected in non-interactive sessions
# with "isn't available in this environment. Run it from the Claude Code
# terminal instead."). Verified May 2026 via grep of
# `~/Library/Application Support/Claude/claude-code/<ver>/claude.app/...`.
#
# Pure-Desktop users (no terminal `claude` installed, or sandboxed) can't
# /plugin install. install.sh fills that gap.
#
# What it does (single path; same end state as /plugin install):
#   1. Deep-copies this repo into `~/.claude/plugins/cache/goal-mode/goal-mode/<ver>/`
#      (the location Claude Code's plugin loader reads, shared by Desktop and CLI).
#   2. Copies `.claude-plugin/marketplace.json` to `~/.claude/plugins/marketplaces/goal-mode/`.
#   3. Registers the marketplace in `~/.claude/plugins/known_marketplaces.json`
#      with `autoUpdate: true` so future versions auto-pull from GitHub.
#   4. Adds `goal-mode` to `~/.claude/settings.json` -> `extraKnownMarketplaces`
#      and `enabledPlugins`.
#
# Because the end state is byte-equivalent to /plugin install, there is no
# duplicate-commands or double-firing-Stop-hook risk. Slash commands appear
# in the picker as `/goal-mode:goal-X` (the canonical plugin namespace).
#
# Idempotent: safe to re-run after `git pull` to refresh the cached version.
# Re-run after a release will overwrite the cache dir.
#
# Requirements: jq, bash, basic POSIX userland. Does NOT require git remote
# access; copies the local working tree.
#
# Uninstall:
#   bash install.sh --uninstall
# (Or, equivalent: remove `~/.claude/plugins/cache/goal-mode/goal-mode/<ver>`,
#  remove `~/.claude/plugins/marketplaces/goal-mode`, jq-edit settings.json
#  and known_marketplaces.json to remove the goal-mode entries.)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_NAME="goal-mode"
MARKETPLACE_NAME="goal-mode"
REPO_GH_PATH="lokafinnsw/claude-code-goal-mode"
SETTINGS="$HOME/.claude/settings.json"
KNOWN="$HOME/.claude/plugins/known_marketplaces.json"
PLUGIN_CACHE_BASE="$HOME/.claude/plugins/cache"
MARKETPLACE_BASE="$HOME/.claude/plugins/marketplaces"

if [[ ! -f "$REPO_ROOT/.claude-plugin/plugin.json" ]]; then
  echo "❌ install.sh must be run from the goal-mode repo root (no .claude-plugin/plugin.json)" >&2
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "❌ jq is required. Install: brew install jq" >&2
  exit 1
fi

# Uninstall mode.
if [[ "${1:-}" == "--uninstall" ]]; then
  echo "→ Uninstalling goal-mode..."
  rm -rf "$PLUGIN_CACHE_BASE/$PLUGIN_NAME"
  rm -rf "$MARKETPLACE_BASE/$MARKETPLACE_NAME"
  if [[ -f "$KNOWN" ]]; then
    jq "del(.\"$MARKETPLACE_NAME\")" "$KNOWN" > "$KNOWN.new" && mv "$KNOWN.new" "$KNOWN"
  fi
  if [[ -f "$SETTINGS" ]]; then
    jq "del(.extraKnownMarketplaces.\"$MARKETPLACE_NAME\") | del(.enabledPlugins.\"${PLUGIN_NAME}@${MARKETPLACE_NAME}\")" "$SETTINGS" > "$SETTINGS.new" && mv "$SETTINGS.new" "$SETTINGS"
  fi
  echo "✅ Uninstalled. Restart Claude (or /reload-plugins in CLI)."
  exit 0
fi

VERSION=$(jq -r .version "$REPO_ROOT/.claude-plugin/plugin.json")
if [[ -z "$VERSION" || "$VERSION" == "null" ]]; then
  echo "❌ failed to read version from .claude-plugin/plugin.json" >&2
  exit 1
fi

CACHE_DIR="$PLUGIN_CACHE_BASE/$PLUGIN_NAME/$PLUGIN_NAME/$VERSION"
MARKETPLACE_DIR="$MARKETPLACE_BASE/$MARKETPLACE_NAME"

echo "→ goal-mode v$VERSION"
echo "→ plugin cache: $CACHE_DIR"
echo "→ marketplace: $MARKETPLACE_DIR"

# 1. Ensure node_modules/zod is vendored (engine runtime dep).
if [[ ! -d "$REPO_ROOT/node_modules/zod" ]]; then
  echo "→ Installing npm dependencies (zod required by engine/state.mjs)..."
  if ! command -v npm >/dev/null 2>&1; then
    echo "❌ npm not found. Install Node.js 20+ first." >&2
    exit 1
  fi
  (cd "$REPO_ROOT" && npm install --no-audit --no-fund)
fi

# 2. Deploy plugin to cache dir (overwrite if exists).
mkdir -p "$(dirname "$CACHE_DIR")"
rm -rf "$CACHE_DIR"
mkdir -p "$CACHE_DIR"
# Copy everything except .git and other heavy/irrelevant directories.
(cd "$REPO_ROOT" && tar --exclude='.git' --exclude='tests/__snapshots__' -cf - .) | (cd "$CACHE_DIR" && tar -xf -)
echo "→ Plugin deployed to cache."

# 3. Deploy marketplace.json to marketplace dir.
mkdir -p "$MARKETPLACE_DIR/.claude-plugin"
cp "$REPO_ROOT/.claude-plugin/marketplace.json" "$MARKETPLACE_DIR/.claude-plugin/marketplace.json"
echo "→ marketplace.json deployed."

# 4. Register in known_marketplaces.json.
mkdir -p "$(dirname "$KNOWN")"
[[ -f "$KNOWN" ]] || echo '{}' > "$KNOWN"
NOW_ISO=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
jq --arg name "$MARKETPLACE_NAME" \
   --arg repo "$REPO_GH_PATH" \
   --arg loc "$MARKETPLACE_DIR" \
   --arg ts "$NOW_ISO" '
  .[$name] = {
    source: { source: "github", repo: $repo },
    installLocation: $loc,
    lastUpdated: $ts,
    autoUpdate: true
  }
' "$KNOWN" > "$KNOWN.new" && mv "$KNOWN.new" "$KNOWN"
echo "→ Registered in known_marketplaces.json (autoUpdate: true)."

# 5. Enable in settings.json + register extraKnownMarketplaces.
[[ -f "$SETTINGS" ]] || echo '{}' > "$SETTINGS"
if ! jq -e . "$SETTINGS" >/dev/null 2>&1; then
  echo "❌ ~/.claude/settings.json is not valid JSON. Fix it manually first." >&2
  exit 1
fi
cp "$SETTINGS" "$SETTINGS.bak-install-$(date +%s)"
jq --arg name "$MARKETPLACE_NAME" \
   --arg plugin "${PLUGIN_NAME}@${MARKETPLACE_NAME}" \
   --arg repo "$REPO_GH_PATH" '
  .extraKnownMarketplaces = (.extraKnownMarketplaces // {}) |
  .extraKnownMarketplaces[$name] = { source: { source: "github", repo: $repo } } |
  .enabledPlugins = (.enabledPlugins // {}) |
  .enabledPlugins[$plugin] = true
' "$SETTINGS" > "$SETTINGS.new" && mv "$SETTINGS.new" "$SETTINGS"
echo "→ Enabled in settings.json."

# 6. Pin version in installed_plugins.json so the plugin loader picks v$VERSION
#    on next session restart (Desktop AND CLI). Without this step the loader
#    keeps the previously-pinned version even if a newer cache dir exists,
#    which is why earlier install.sh runs visibly deployed but didn't activate.
INSTALLED="$HOME/.claude/plugins/installed_plugins.json"
mkdir -p "$(dirname "$INSTALLED")"
[[ -f "$INSTALLED" ]] || echo '{"version":2,"plugins":{}}' > "$INSTALLED"
if ! jq -e . "$INSTALLED" >/dev/null 2>&1; then
  echo "❌ ~/.claude/plugins/installed_plugins.json is not valid JSON. Fix it manually first." >&2
  exit 1
fi
PIN_KEY="${PLUGIN_NAME}@${MARKETPLACE_NAME}"
jq --arg key "$PIN_KEY" \
   --arg path "$CACHE_DIR" \
   --arg ver "$VERSION" \
   --arg ts "$NOW_ISO" '
  .plugins = (.plugins // {}) |
  .plugins[$key] = [{
    scope: "user",
    installPath: $path,
    version: $ver,
    installedAt: (.plugins[$key][0].installedAt // $ts),
    lastUpdated: $ts
  }]
' "$INSTALLED" > "$INSTALLED.new" && mv "$INSTALLED.new" "$INSTALLED"
echo "→ Pinned v$VERSION in installed_plugins.json (loader will use this version on next session)."

echo ""
echo "✅ goal-mode v$VERSION installed (plugin cache path; same end state as /plugin install)."
echo ""
echo "Slash commands appear as /goal-mode:goal-X in the picker (canonical plugin namespace)."
echo "Restart Claude Desktop / Claude Code to load. In CLI you can /reload-plugins."
echo ""
echo "Next:"
echo "  /goal-mode:goal-help        — show command list"
echo "  /goal-mode:goal-plan-from-file <path> — convert existing markdown plan"
echo "  /goal-mode:goal-plan \"<mission>\"      — bootstrap from scratch"
echo "  /goal-mode:goal-approve-plan          — validate + lock"
echo "  /goal-mode:goal-start --max-iter 200 --token-budget 5000000 --time-budget 8h"
