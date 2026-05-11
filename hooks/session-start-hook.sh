#!/usr/bin/env bash
# SessionStart hook — auto-resume goal continuation.
set -euo pipefail
: "${CLAUDE_PLUGIN_ROOT:=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
node "${CLAUDE_PLUGIN_ROOT}/engine/session-start-cli.mjs"
