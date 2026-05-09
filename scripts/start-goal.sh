#!/usr/bin/env bash
# /goal:start shim — invokes the Node CLI wrapper.
# CLAUDE_PLUGIN_ROOT is set by Claude Code for slash-command hooks.
set -euo pipefail
node "${CLAUDE_PLUGIN_ROOT}/engine/start-goal-cli.mjs" "$@"
