#!/usr/bin/env bash
# Phase 0: no-op stop hook. Replaced by Node engine in Phase 4.
set -euo pipefail
# Drain stdin so Claude Code doesn't block on the pipe.
cat >/dev/null
exit 0
