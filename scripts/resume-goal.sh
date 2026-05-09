#!/usr/bin/env bash
# /goal:resume shim.
set -euo pipefail
node "${CLAUDE_PLUGIN_ROOT}/engine/pause-resume-cli.mjs" resume
