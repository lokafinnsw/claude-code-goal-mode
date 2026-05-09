#!/usr/bin/env bash
# Stop hook shim — runs the Node engine.
# CLAUDE_PLUGIN_ROOT is set by Claude Code for hooks; it points to the
# plugin's installation directory.
# Project root (cwd of the user's Claude Code session) is the working dir,
# inherited from the hook caller.
set -euo pipefail
exec node "${CLAUDE_PLUGIN_ROOT}/engine/stop-hook-cli.mjs"
