#!/usr/bin/env bash
# Stop hook shim — runs the Node engine.
# CLAUDE_PLUGIN_ROOT is set by Claude Code CLI for hooks; it points to the
# plugin's installation directory. For Desktop (install.sh path), the env
# var is set inline by the registered hook command, but the line below is a
# defensive fallback that derives from this script's own location.
# Project root (cwd of the user's Claude Code session) is the working dir,
# inherited from the hook caller.
set -euo pipefail
: "${CLAUDE_PLUGIN_ROOT:=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
exec node "${CLAUDE_PLUGIN_ROOT}/engine/stop-hook-cli.mjs"
