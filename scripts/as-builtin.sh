#!/usr/bin/env bash
set -euo pipefail
: "${CLAUDE_PLUGIN_ROOT:=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
exec node "${CLAUDE_PLUGIN_ROOT}/engine/current-cli.mjs" --as-builtin "$@"
