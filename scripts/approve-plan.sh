#!/usr/bin/env bash
# /goal:approve-plan shim.
set -euo pipefail
: "${CLAUDE_PLUGIN_ROOT:=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
node "${CLAUDE_PLUGIN_ROOT}/engine/approve-plan-cli.mjs" "$@"
