#!/usr/bin/env bash
# /goal:pause shim.
set -euo pipefail
: "${CLAUDE_PLUGIN_ROOT:=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
node "${CLAUDE_PLUGIN_ROOT}/engine/pause-resume-cli.mjs" pause
