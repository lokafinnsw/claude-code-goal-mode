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
 *   3. Resolve the project root via `resolveProjectRoot(stdin)`:
 *      - **Prefer `stdin.cwd`** (Claude Code's canonical per-session project
 *        dir, included in the hook payload per the public hooks protocol).
 *      - Fall back to `process.cwd()` only when `stdin.cwd` is missing /
 *        empty / non-absolute / non-existent.
 *      This fixes a cross-project leakage bug (user-reported 2026-05-11)
 *      where Claude Desktop sometimes spawns hooks for ALL session tabs from
 *      a single host process with the host's initial cwd, regardless of which
 *      tab fired the Stop event. In that scenario `process.cwd()` returns the
 *      Desktop launch dir instead of the per-tab session project dir, so the
 *      hook ends up reading `.claude/goals/active/` from the WRONG project's
 *      tree and injects an unrelated continuation prompt. `stdin.cwd` is set
 *      by Claude Code per-event and always refers to the calling session's
 *      project, so it is the canonical source of truth.
 *   4. Invoke `runStopHook({ stdin, projectRoot })`.
 *   5. If the orchestrator returned a non-null `stdout` payload, serialize it
 *      and write to process.stdout. Claude Code reads this back as the hook
 *      response (which can drive `decision: 'block'` to inject a continuation
 *      prompt).
 *   6. Exit with the orchestrator's exit code (always 0 — errors are swallowed
 *      and observed via stderr, not exit code, so the hook never crashes).
 *
 * The shebang line and the executable bit on this file are required for
 * direct invocation via `node engine/stop-hook-cli.mjs`. The bash shim
 * (`hooks/stop-hook.sh`) `exec`s into this script with CLAUDE_PLUGIN_ROOT
 * already set by Claude Code.
 *
 * Tests: tests/project-root-resolution.test.mjs covers the `stdin.cwd` vs
 * `process.cwd()` precedence + fallback edge cases.
 */

import fs from 'node:fs';
import path from 'node:path';
import { runStopHook } from './stop-hook.mjs';
import { resolveProjectRoot } from './project-root.mjs';

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

const projectRoot = resolveProjectRoot(stdin, { fs, path, fallbackCwd: process.cwd() });
const result = await runStopHook({ stdin, projectRoot });
if (result.stdout) {
  process.stdout.write(JSON.stringify(result.stdout));
}
process.exit(result.exit);
