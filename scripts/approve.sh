#!/usr/bin/env bash
# /goal:approve shim.
set -euo pipefail
node "${CLAUDE_PLUGIN_ROOT}/engine/approve-cli.mjs" "$@"
