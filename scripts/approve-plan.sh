#!/usr/bin/env bash
# /goal:approve-plan shim.
set -euo pipefail
node "${CLAUDE_PLUGIN_ROOT}/engine/approve-plan-cli.mjs" "$@"
