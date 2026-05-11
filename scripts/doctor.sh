#!/usr/bin/env bash
# /goal-mode:goal-doctor shim — invokes the Node CLI wrapper.
# CLAUDE_PLUGIN_ROOT is set by Claude Code's plugin loader. For Desktop
# (install.sh path), it is unset; the line below derives it from this
# script's own location ({plugin-root}/scripts/doctor.sh -> {plugin-root}).
set -euo pipefail
: "${CLAUDE_PLUGIN_ROOT:=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
node "${CLAUDE_PLUGIN_ROOT}/engine/doctor-cli.mjs" "$@"
