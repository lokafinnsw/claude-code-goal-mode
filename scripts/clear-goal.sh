#!/usr/bin/env bash
# /goal:clear shim.
set -euo pipefail
node "${CLAUDE_PLUGIN_ROOT}/engine/clear-cli.mjs" "$@"
