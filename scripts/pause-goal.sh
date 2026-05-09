#!/usr/bin/env bash
# /goal:pause shim.
set -euo pipefail
node "${CLAUDE_PLUGIN_ROOT}/engine/pause-resume-cli.mjs" pause
