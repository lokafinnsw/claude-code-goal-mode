#!/usr/bin/env node
/**
 * Stop-hook CLI entrypoint — the bridge between Claude Code's Stop hook
 * (which speaks JSON over stdin/stdout) and the engine's `runStopHook`
 * orchestrator.
 *
 * Behavior:
 *   1. Read all of stdin as a single UTF-8 string.
 *   2. Try to parse the string as JSON. If parsing fails (no stdin / malformed),
 *      fall back to an empty object — `runStopHook` will then short-circuit on
 *      session_id mismatch or missing state.
 *   3. Invoke `runStopHook({ stdin: parsed, projectRoot: process.cwd() })`.
 *      `process.cwd()` is the user's Claude Code session directory, which is
 *      where `.claude/goals/active/` lives.
 *   4. If the orchestrator returned a non-null `stdout` payload, serialize it
 *      and write to process.stdout. Claude Code reads this back as the hook
 *      response (which can drive `decision: 'block'` to inject a continuation
 *      prompt).
 *   5. Exit with the orchestrator's exit code (always 0 — errors are swallowed
 *      and observed via stderr, not exit code, so the hook never crashes).
 *
 * The shebang line and the executable bit on this file are required for
 * direct invocation via `node engine/stop-hook-cli.mjs`. The bash shim
 * (`hooks/stop-hook.sh`) `exec`s into this script with CLAUDE_PLUGIN_ROOT
 * already set by Claude Code.
 *
 * No tests target this file directly because it is a thin I/O wrapper:
 * stdin → JSON → runStopHook → stdout/JSON → exit. The orchestrator
 * (`engine/stop-hook.mjs`) is comprehensively tested through integration.test.mjs
 * and phase-4-multi-iteration.test.mjs.
 */

import { runStopHook } from './stop-hook.mjs';

let raw = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) raw += chunk;

let stdin = {};
try {
  stdin = raw.trim() ? JSON.parse(raw) : {};
} catch {
  // No stdin or malformed JSON: empty stdin object causes runStopHook to
  // short-circuit on the session_id mismatch gate, returning {exit:0, stdout:null}.
  stdin = {};
}

const result = await runStopHook({ stdin, projectRoot: process.cwd() });
if (result.stdout) {
  process.stdout.write(JSON.stringify(result.stdout));
}
process.exit(result.exit);
