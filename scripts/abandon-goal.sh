#!/usr/bin/env bash
# /goal:abandon shim.
set -euo pipefail
: "${CLAUDE_PLUGIN_ROOT:=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
node "${CLAUDE_PLUGIN_ROOT}/engine/abandon-cli.mjs" "$@"
