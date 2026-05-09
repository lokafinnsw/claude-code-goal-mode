#!/usr/bin/env bash
# /goal:abandon shim.
set -euo pipefail
node "${CLAUDE_PLUGIN_ROOT}/engine/abandon-cli.mjs" "$@"
