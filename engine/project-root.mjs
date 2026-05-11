/**
 * Project-root resolution — pure, testable, used by both Stop and SessionStart
 * hook CLIs.
 *
 * Why this is its own module (rather than inline `process.cwd()`):
 *
 *   Claude Code's hook protocol passes a `cwd` field in the JSON stdin payload
 *   sent to each hook invocation. That field is the canonical per-event
 *   project directory — Claude Code sets it to the calling session's project
 *   regardless of where the hook host process was spawned. In Claude Desktop
 *   in particular, the same host process can fan out hook calls for multiple
 *   open session tabs, each with a different project. If the plugin trusts
 *   `process.cwd()`, all hooks resolve to the host's initial launch dir →
 *   ONE project's `.claude/goals/active/` leaks into every other session's
 *   continuation prompts. User reported this on 2026-05-11 as "mancelot
 *   continuation appears in all my other projects".
 *
 *   Fix: when `stdin.cwd` is present, absolute, and points at a real
 *   directory on disk, treat it as the source of truth. Otherwise fall back
 *   to `process.cwd()` (which is the existing v2.0.x behavior).
 *
 * The validation chain is deliberately strict: a missing, empty, relative,
 * or non-existent `stdin.cwd` falls through to the fallback rather than
 * silently writing state under a half-resolved path. This makes the
 * behavior predictable and easy to reason about in tests.
 *
 * @param {object} stdin - Parsed Claude Code hook stdin (may be {}).
 * @param {object} deps
 * @param {typeof import('node:fs')} deps.fs - Injected for testability.
 * @param {typeof import('node:path')} deps.path - Injected for testability.
 * @param {string} deps.fallbackCwd - Value to use when stdin.cwd is unusable.
 * @returns {string} Absolute project-root path.
 */
export function resolveProjectRoot(stdin, { fs, path, fallbackCwd }) {
  const candidate = stdin && typeof stdin === 'object' ? stdin.cwd : null;
  if (typeof candidate !== 'string' || candidate.length === 0) {
    return fallbackCwd;
  }
  // Absolute-path requirement: Claude Code documents `cwd` as absolute, but
  // we don't want to silently accept a relative path and resolve it against
  // the host process's cwd (which would re-introduce the leakage). Reject
  // anything that doesn't start with '/'.
  if (!path.isAbsolute(candidate)) {
    return fallbackCwd;
  }
  // Existence check — if the dir doesn't exist, the goal state is also not
  // going to exist; fall back gives a deterministic error path via the
  // normal "no active goal" gate downstream.
  try {
    const st = fs.statSync(candidate);
    if (!st.isDirectory()) return fallbackCwd;
  } catch {
    return fallbackCwd;
  }
  // Normalize to remove trailing slashes, '..', '//' etc., so equality
  // comparisons elsewhere in the engine are stable.
  return path.resolve(candidate);
}
