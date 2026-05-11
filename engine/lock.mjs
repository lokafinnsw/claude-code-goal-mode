/**
 * File-based advisory lock — per-goal directory.
 *
 * Implements ADR 0002 (Concurrent Session Locking). The lock serializes
 * write-intent operations (Stop hook, CLI scripts that mutate state) so
 * read-decide-write sequences in different processes don't trample each
 * other.
 *
 * Surface:
 *   - acquireLock(goalDir, intent, opts?) → LockHandle
 *   - releaseLock(handle) → void
 *   - isLocked(goalDir) → { locked, holder?, stale }
 *   - breakStaleLock(goalDir, reason) → boolean
 *
 * Lock semantics:
 *   - Exclusive: only one holder at a time per goalDir.
 *   - Advisory: only respected by callers that bother to acquire.
 *   - Read-only callers (loadState, render-status) intentionally do NOT lock.
 *   - PID + host + acquired_at + ttl_seconds recorded for forensics + stale
 *     detection.
 *   - Stale heuristic: PID not alive on this host AND age < ttl_seconds is
 *     conservative — we prefer waiting for a possibly-live remote PID over
 *     breaking a valid lock.
 *
 * File format: .claude/goals/<goal-id>/.lock, JSON:
 *   {
 *     schema_version: 1,
 *     pid: 12345,
 *     session_id: "uuid",
 *     intent: "stop-hook-tick" | "goal-pause" | ...,
 *     acquired_at: "2026-05-11T...",
 *     ttl_seconds: 30,
 *     host: "macbook.local"
 *   }
 *
 * Process-exit cleanup: every script that acquires registers a SIGTERM/exit
 * cleanup that releases the lock. PID + ttl is the safety net for SIGKILL /
 * OOM / hard-crash cases where signal handlers don't fire.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { z } from 'zod';

export const LOCK_FILENAME = '.lock';
export const DEFAULT_TTL_SECONDS = 30;
export const DEFAULT_TIMEOUT_MS = 5000;

const BACKOFF_SCHEDULE_MS = [100, 200, 400, 800, 1600];

export const LockInfoSchema = z.object({
  schema_version: z.literal(1),
  pid: z.number().int().positive(),
  session_id: z.string().min(1),
  intent: z.string().min(1),
  acquired_at: z.string().datetime(),
  ttl_seconds: z.number().int().positive(),
  host: z.string().min(1),
});

export class LockTimeoutError extends Error {
  constructor(message, holder) {
    super(message);
    this.name = 'LockTimeoutError';
    this.holder = holder;
  }
}

function lockPath(goalDir) {
  return path.join(goalDir, LOCK_FILENAME);
}

function readLockInfo(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return LockInfoSchema.parse(parsed);
  } catch {
    return null;
  }
}

/**
 * PID liveness check, host-local only.
 *
 * `process.kill(pid, 0)` does NOT send a signal — it tests whether the
 * caller has permission to signal the PID and whether the PID exists. ESRCH
 * = no such process. EPERM = process exists but caller lacks permission
 * (still alive, so we treat as alive). Any other error = treat as dead.
 *
 * On a different host (NFS / SMB scenario), this check is meaningless. The
 * caller must guard with `info.host === os.hostname()` before relying on it.
 */
function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err.code === 'EPERM') return true;
    return false;
  }
}

function isStale(info) {
  if (!info) return false;
  // Host check: only do the liveness probe if the lock was acquired on this
  // host. Cross-host locks are conservatively assumed live until TTL expires.
  if (info.host !== os.hostname()) {
    const ageMs = Date.now() - new Date(info.acquired_at).getTime();
    return ageMs > info.ttl_seconds * 1000;
  }
  // Host-local: PID liveness is the primary signal. TTL is a secondary
  // safety net for cases where PID was recycled (extremely unlikely within
  // 30 seconds but theoretically possible).
  if (!isPidAlive(info.pid)) return true;
  const ageMs = Date.now() - new Date(info.acquired_at).getTime();
  return ageMs > info.ttl_seconds * 1000;
}

/**
 * Inspect a lock without acquiring or modifying it.
 */
export function isLocked(goalDir) {
  const info = readLockInfo(lockPath(goalDir));
  if (!info) return { locked: false, stale: false };
  return { locked: true, holder: info, stale: isStale(info) };
}

/**
 * Forcibly remove a stale lock. Returns true if a file was removed.
 * Caller MUST verify staleness first via isLocked(); this function does NOT
 * re-validate. It exists as the explicit "I know what I'm doing" override.
 */
export function breakStaleLock(goalDir, reason) {
  const fp = lockPath(goalDir);
  try {
    const before = readLockInfo(fp);
    if (!before) return false;
    fs.unlinkSync(fp);
    process.stderr.write(
      `[goal-mode] broke stale lock at ${fp}: prior holder pid=${before.pid} intent=${before.intent} acquired_at=${before.acquired_at}; reason: ${reason}\n`,
    );
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
}

/**
 * Attempt to acquire the lock for the given goal directory.
 *
 * Algorithm:
 *   1. Open lockfile with O_CREAT | O_EXCL (`'wx'`). On success, write
 *      LockInfo and return handle.
 *   2. On EEXIST, read current holder. If stale, break and retry from 1.
 *   3. If not stale, sleep with exponential backoff (+ jitter) and retry.
 *   4. After total `timeoutMs` elapsed without success, throw
 *      LockTimeoutError with the current holder info.
 *
 * `opts.force = true` skips the wait and breaks any lock (including
 * non-stale). Use only from `/goal-unlock` style emergency commands.
 */
export async function acquireLock(goalDir, intent, opts = {}) {
  const sessionId = opts.sessionId ?? process.env.CLAUDE_CODE_SESSION_ID ?? `pid-${process.pid}`;
  const ttlSeconds = opts.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const force = opts.force === true;
  fs.mkdirSync(goalDir, { recursive: true });
  const fp = lockPath(goalDir);
  const start = Date.now();
  let attempt = 0;

  while (true) {
    if (force) breakStaleLock(goalDir, 'force-override');
    const info = {
      schema_version: 1,
      pid: process.pid,
      session_id: sessionId,
      intent,
      acquired_at: new Date().toISOString(),
      ttl_seconds: ttlSeconds,
      host: os.hostname(),
    };
    try {
      const fd = fs.openSync(fp, 'wx');
      try {
        fs.writeSync(fd, JSON.stringify(info, null, 2));
      } finally {
        fs.closeSync(fd);
      }
      return { lockPath: fp, info };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
    // Lockfile exists — inspect.
    const existing = readLockInfo(fp);
    if (existing && isStale(existing)) {
      breakStaleLock(goalDir, `stale (pid=${existing.pid} acquired_at=${existing.acquired_at} ttl=${existing.ttl_seconds}s)`);
      continue;
    }
    // Lock is held by a live process. Wait + retry until timeout.
    const elapsed = Date.now() - start;
    if (elapsed >= timeoutMs) {
      throw new LockTimeoutError(
        `Failed to acquire lock at ${fp} within ${timeoutMs}ms. Held by pid=${existing?.pid ?? '?'} intent=${existing?.intent ?? '?'} session=${existing?.session_id ?? '?'}`,
        existing,
      );
    }
    const base = BACKOFF_SCHEDULE_MS[Math.min(attempt, BACKOFF_SCHEDULE_MS.length - 1)];
    const jitter = base * 0.25 * (Math.random() * 2 - 1);
    const sleepMs = Math.min(base + jitter, timeoutMs - elapsed);
    await new Promise((r) => setTimeout(r, Math.max(10, sleepMs)));
    attempt += 1;
  }
}

/**
 * Synchronous variant — for CLI scripts that want to acquire on entry.
 * Same algorithm; uses busy-sleep instead of setTimeout (acceptable for
 * the short timeouts we use).
 */
export function acquireLockSync(goalDir, intent, opts = {}) {
  const sessionId = opts.sessionId ?? process.env.CLAUDE_CODE_SESSION_ID ?? `pid-${process.pid}`;
  const ttlSeconds = opts.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const force = opts.force === true;
  fs.mkdirSync(goalDir, { recursive: true });
  const fp = lockPath(goalDir);
  const start = Date.now();
  let attempt = 0;

  while (true) {
    if (force) breakStaleLock(goalDir, 'force-override');
    const info = {
      schema_version: 1,
      pid: process.pid,
      session_id: sessionId,
      intent,
      acquired_at: new Date().toISOString(),
      ttl_seconds: ttlSeconds,
      host: os.hostname(),
    };
    try {
      const fd = fs.openSync(fp, 'wx');
      try {
        fs.writeSync(fd, JSON.stringify(info, null, 2));
      } finally {
        fs.closeSync(fd);
      }
      return { lockPath: fp, info };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
    const existing = readLockInfo(fp);
    if (existing && isStale(existing)) {
      breakStaleLock(goalDir, `stale (pid=${existing.pid} acquired_at=${existing.acquired_at} ttl=${existing.ttl_seconds}s)`);
      continue;
    }
    const elapsed = Date.now() - start;
    if (elapsed >= timeoutMs) {
      throw new LockTimeoutError(
        `Failed to acquire lock at ${fp} within ${timeoutMs}ms. Held by pid=${existing?.pid ?? '?'} intent=${existing?.intent ?? '?'} session=${existing?.session_id ?? '?'}`,
        existing,
      );
    }
    const base = BACKOFF_SCHEDULE_MS[Math.min(attempt, BACKOFF_SCHEDULE_MS.length - 1)];
    const jitter = base * 0.25 * (Math.random() * 2 - 1);
    const sleepMs = Math.min(base + jitter, timeoutMs - elapsed);
    // Synchronous sleep via Atomics.wait on a SharedArrayBuffer is the only
    // way without async/await; we keep it under 100ms total in practice.
    const sab = new SharedArrayBuffer(4);
    const view = new Int32Array(sab);
    Atomics.wait(view, 0, 0, Math.max(10, sleepMs));
    attempt += 1;
  }
}

/**
 * Release a lock acquired by this process. Verifies PID match — if the
 * file no longer has our PID (e.g., someone broke it and re-acquired),
 * we log a warning and don't delete.
 */
export function releaseLock(handle) {
  if (!handle?.lockPath) return;
  try {
    const current = readLockInfo(handle.lockPath);
    if (!current) return; // already released or broken
    if (current.pid !== process.pid) {
      process.stderr.write(
        `[goal-mode] lock release skipped: ${handle.lockPath} now held by pid=${current.pid} (expected pid=${process.pid})\n`,
      );
      return;
    }
    fs.unlinkSync(handle.lockPath);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      process.stderr.write(`[goal-mode] lock release error: ${err.message}\n`);
    }
  }
}

/**
 * Register process-exit + SIGTERM / SIGINT handlers that release the given
 * handle. Returns an unregister function for callers that want to manage
 * release manually.
 *
 * SIGKILL and OOM cannot fire handlers — TTL + PID liveness in the next
 * acquirer's stale check is the safety net for those.
 */
export function registerExitCleanup(handle) {
  let released = false;
  function cleanup() {
    if (released) return;
    released = true;
    releaseLock(handle);
  }
  const onSigInt = () => { cleanup(); process.exit(130); };
  const onSigTerm = () => { cleanup(); process.exit(143); };
  process.on('exit', cleanup);
  process.on('SIGINT', onSigInt);
  process.on('SIGTERM', onSigTerm);
  return () => {
    // Remove ALL three listeners — earlier versions only removed 'exit',
    // leaving SIGINT/SIGTERM accumulating across many withLock calls in
    // the same process (test suites trip MaxListeners=10 warning + slowdown).
    process.off('exit', cleanup);
    process.off('SIGINT', onSigInt);
    process.off('SIGTERM', onSigTerm);
  };
}

/**
 * Convenience wrapper: acquire → run → release, with automatic cleanup
 * on exception or normal completion. Use this in CLI scripts.
 */
export async function withLock(goalDir, intent, opts, fn) {
  const handle = await acquireLock(goalDir, intent, opts);
  const unregister = registerExitCleanup(handle);
  try {
    return await fn(handle);
  } finally {
    unregister();
    releaseLock(handle);
  }
}

/**
 * Synchronous variant of withLock for CLI scripts that don't need async.
 */
export function withLockSync(goalDir, intent, opts, fn) {
  const handle = acquireLockSync(goalDir, intent, opts);
  const unregister = registerExitCleanup(handle);
  try {
    return fn(handle);
  } finally {
    unregister();
    releaseLock(handle);
  }
}
