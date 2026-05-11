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
export function resolveProjectRoot(stdin, { fs, path, fallbackCwd, stderrWrite }) {
  // Local stderr write wrapper for testability (tests inject a no-op).
  const warn = typeof stderrWrite === 'function'
    ? stderrWrite
    : ((msg) => process.stderr.write(msg));

  const stdinIsObject = stdin && typeof stdin === 'object';
  const cwdMissing = !stdinIsObject || typeof stdin.cwd !== 'string' || stdin.cwd.length === 0;
  // Case 1: stdin.cwd entirely missing → fallback. This matches old (pre-cwd-protocol)
  // CC versions and is the documented backward-compat path.
  if (cwdMissing) {
    return fallbackCwd;
  }
  const candidate = stdin.cwd;
  // Case 2: stdin.cwd present but malformed (relative / non-existent / not-a-dir).
  // This signals either a CC bug or hand-tampered stdin. Pre-v2.0.3 we silently
  // fell back to process.cwd(), which could re-introduce the cross-project
  // leak fixed by v2.0.2. v2.0.3 (bug O3 hardening): emit a diagnostic and
  // STILL fall back, but the warning gives Claude Code engineers + users a
  // breadcrumb. We don't hard-fail (return null) because that would break
  // every hook fire if CC ever ships a corrupt cwd field — better to log
  // and continue with the conservative best-guess.
  if (!path.isAbsolute(candidate)) {
    warn(`[goal-mode] resolveProjectRoot: stdin.cwd="${candidate}" is not absolute; falling back to process.cwd()=${fallbackCwd}\n`);
    return fallbackCwd;
  }
  try {
    const st = fs.statSync(candidate);
    if (!st.isDirectory()) {
      warn(`[goal-mode] resolveProjectRoot: stdin.cwd="${candidate}" is not a directory; falling back to process.cwd()=${fallbackCwd}\n`);
      return fallbackCwd;
    }
  } catch (err) {
    warn(`[goal-mode] resolveProjectRoot: stdin.cwd="${candidate}" stat failed (${err.code || err.message}); falling back to process.cwd()=${fallbackCwd}\n`);
    return fallbackCwd;
  }
  return path.resolve(candidate);
}
