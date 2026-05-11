import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  acquireLock,
  acquireLockSync,
  releaseLock,
  isLocked,
  breakStaleLock,
  withLock,
  withLockSync,
  LockInfoSchema,
  LockTimeoutError,
  LOCK_FILENAME,
  DEFAULT_TTL_SECONDS,
} from '../engine/lock.mjs';

function mkGoalDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'goal-lock-'));
}

describe('LockInfoSchema', () => {
  it('accepts a well-formed lock info', () => {
    const info = {
      schema_version: 1, pid: 1234, session_id: 's',
      intent: 'stop-hook-tick',
      acquired_at: new Date().toISOString(),
      ttl_seconds: 30, host: 'h',
    };
    expect(() => LockInfoSchema.parse(info)).not.toThrow();
  });
  it('rejects bad schema_version', () => {
    expect(() => LockInfoSchema.parse({ schema_version: 99 })).toThrow();
  });
  it('rejects negative pid', () => {
    const info = {
      schema_version: 1, pid: -1, session_id: 's',
      intent: 'x', acquired_at: new Date().toISOString(),
      ttl_seconds: 30, host: 'h',
    };
    expect(() => LockInfoSchema.parse(info)).toThrow();
  });
});

describe('isLocked', () => {
  it('returns locked:false when no lockfile exists', () => {
    const dir = mkGoalDir();
    expect(isLocked(dir)).toEqual({ locked: false, stale: false });
  });
  it('returns locked:true with holder info when lockfile exists', () => {
    const dir = mkGoalDir();
    const handle = acquireLockSync(dir, 'test-intent');
    try {
      const s = isLocked(dir);
      expect(s.locked).toBe(true);
      expect(s.holder.pid).toBe(process.pid);
      expect(s.holder.intent).toBe('test-intent');
      expect(s.stale).toBe(false);
    } finally {
      releaseLock(handle);
    }
  });
  it('returns locked:false when lockfile content is malformed JSON', () => {
    const dir = mkGoalDir();
    fs.writeFileSync(path.join(dir, LOCK_FILENAME), '{not json');
    expect(isLocked(dir)).toEqual({ locked: false, stale: false });
  });
});

describe('acquireLock (async happy path)', () => {
  it('writes a valid LockInfo to .lock', async () => {
    const dir = mkGoalDir();
    const handle = await acquireLock(dir, 'goal-pause');
    try {
      const onDisk = JSON.parse(fs.readFileSync(handle.lockPath, 'utf8'));
      expect(onDisk.pid).toBe(process.pid);
      expect(onDisk.intent).toBe('goal-pause');
      expect(onDisk.host).toBe(os.hostname());
      expect(() => LockInfoSchema.parse(onDisk)).not.toThrow();
    } finally {
      releaseLock(handle);
    }
  });

  it('release removes the lockfile', async () => {
    const dir = mkGoalDir();
    const handle = await acquireLock(dir, 'test');
    expect(fs.existsSync(handle.lockPath)).toBe(true);
    releaseLock(handle);
    expect(fs.existsSync(handle.lockPath)).toBe(false);
  });

  it('respects custom ttlSeconds', async () => {
    const dir = mkGoalDir();
    const handle = await acquireLock(dir, 'test', { ttlSeconds: 60 });
    try {
      const onDisk = JSON.parse(fs.readFileSync(handle.lockPath, 'utf8'));
      expect(onDisk.ttl_seconds).toBe(60);
    } finally {
      releaseLock(handle);
    }
  });
});

describe('acquireLock (contention)', () => {
  it('second acquire blocks until first releases', async () => {
    const dir = mkGoalDir();
    const first = await acquireLock(dir, 'first');
    // Schedule release after 150ms.
    setTimeout(() => releaseLock(first), 150);
    const startedAt = Date.now();
    const second = await acquireLock(dir, 'second', { timeoutMs: 2000 });
    const waited = Date.now() - startedAt;
    expect(waited).toBeGreaterThan(100);
    expect(second.info.intent).toBe('second');
    releaseLock(second);
  });

  it('times out when holder never releases', async () => {
    const dir = mkGoalDir();
    const held = await acquireLock(dir, 'never-releases');
    try {
      await expect(
        acquireLock(dir, 'second', { timeoutMs: 200 }),
      ).rejects.toThrow(LockTimeoutError);
    } finally {
      releaseLock(held);
    }
  });

  it('LockTimeoutError carries holder info', async () => {
    const dir = mkGoalDir();
    const held = await acquireLock(dir, 'busy');
    try {
      try {
        await acquireLock(dir, 'second', { timeoutMs: 100 });
        throw new Error('expected timeout');
      } catch (err) {
        expect(err).toBeInstanceOf(LockTimeoutError);
        expect(err.holder.intent).toBe('busy');
        expect(err.holder.pid).toBe(process.pid);
      }
    } finally {
      releaseLock(held);
    }
  });
});

describe('stale lock detection + breakage', () => {
  it('breakStaleLock returns false when no lock exists', () => {
    expect(breakStaleLock(mkGoalDir(), 'test')).toBe(false);
  });

  it('breakStaleLock removes the lockfile and returns true', () => {
    const dir = mkGoalDir();
    const handle = acquireLockSync(dir, 'test');
    expect(fs.existsSync(handle.lockPath)).toBe(true);
    // Suppress stderr from the break message.
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = () => true;
    try {
      expect(breakStaleLock(dir, 'unit-test')).toBe(true);
      expect(fs.existsSync(handle.lockPath)).toBe(false);
    } finally {
      process.stderr.write = orig;
    }
  });

  it('isStale: returns stale=true when host matches but pid is dead', () => {
    const dir = mkGoalDir();
    // Hand-write a lock with a definitely-dead PID (PID 1 on macOS is launchd,
    // very much alive; we need a PID that's NOT alive — pick a very large one).
    const deadPid = 999_999_999;
    fs.writeFileSync(
      path.join(dir, LOCK_FILENAME),
      JSON.stringify({
        schema_version: 1, pid: deadPid, session_id: 's',
        intent: 'x', acquired_at: new Date().toISOString(),
        ttl_seconds: 30, host: os.hostname(),
      }),
    );
    const s = isLocked(dir);
    expect(s.locked).toBe(true);
    expect(s.stale).toBe(true);
  });

  it('isStale: returns stale=true when age exceeds ttl even with live pid', () => {
    const dir = mkGoalDir();
    fs.writeFileSync(
      path.join(dir, LOCK_FILENAME),
      JSON.stringify({
        schema_version: 1, pid: process.pid, session_id: 's',
        intent: 'x',
        acquired_at: new Date(Date.now() - 60_000).toISOString(),
        ttl_seconds: 30, host: os.hostname(),
      }),
    );
    const s = isLocked(dir);
    expect(s.stale).toBe(true);
  });

  it('isStale: cross-host lock is conservatively NOT stale while inside TTL', () => {
    const dir = mkGoalDir();
    fs.writeFileSync(
      path.join(dir, LOCK_FILENAME),
      JSON.stringify({
        schema_version: 1, pid: 99999, session_id: 's',
        intent: 'x', acquired_at: new Date().toISOString(),
        ttl_seconds: 30, host: 'some-other-host',
      }),
    );
    const s = isLocked(dir);
    expect(s.locked).toBe(true);
    expect(s.stale).toBe(false); // conservative
  });

  it('acquireLock breaks stale lock and proceeds', async () => {
    const dir = mkGoalDir();
    fs.writeFileSync(
      path.join(dir, LOCK_FILENAME),
      JSON.stringify({
        schema_version: 1, pid: 999_999_999, session_id: 's',
        intent: 'orphaned', acquired_at: new Date().toISOString(),
        ttl_seconds: 30, host: os.hostname(),
      }),
    );
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = () => true;
    try {
      const handle = await acquireLock(dir, 'recovery');
      expect(handle.info.intent).toBe('recovery');
      releaseLock(handle);
    } finally {
      process.stderr.write = orig;
    }
  });

  // ADR 0002 acknowledges PID-reuse is theoretical (32-bit pids wrap, 30s
  // window). We document the limitation here as an explicit test.
  it('LIMITATION: PID reuse within TTL window is not detected', () => {
    const dir = mkGoalDir();
    fs.writeFileSync(
      path.join(dir, LOCK_FILENAME),
      JSON.stringify({
        schema_version: 1, pid: process.pid, session_id: 'original',
        intent: 'orig', acquired_at: new Date().toISOString(),
        ttl_seconds: 30, host: os.hostname(),
      }),
    );
    // From the lock's perspective, our PID is still "alive" — even though
    // the original holder may have died and another process reused the PID.
    // The conservative result is that the lock looks held by us.
    const s = isLocked(dir);
    expect(s.stale).toBe(false);
  });
});

describe('force override', () => {
  it('force:true breaks any existing lock and acquires', async () => {
    const dir = mkGoalDir();
    const held = await acquireLock(dir, 'busy');
    try {
      const orig = process.stderr.write.bind(process.stderr);
      process.stderr.write = () => true;
      try {
        const forced = await acquireLock(dir, 'force', { force: true });
        expect(forced.info.intent).toBe('force');
        releaseLock(forced);
      } finally {
        process.stderr.write = orig;
      }
    } finally {
      // The original handle is now invalid; releasing it is a no-op since
      // someone else owns the lock file. Confirm release-skip path.
      releaseLock(held);
    }
  });
});

describe('releaseLock with mismatched pid', () => {
  it('does not delete a lockfile owned by a different pid', () => {
    const dir = mkGoalDir();
    // Hand-write a lock owned by another PID.
    fs.writeFileSync(
      path.join(dir, LOCK_FILENAME),
      JSON.stringify({
        schema_version: 1, pid: 999_999_998, session_id: 's',
        intent: 'someone-else', acquired_at: new Date().toISOString(),
        ttl_seconds: 30, host: os.hostname(),
      }),
    );
    const fakeHandle = { lockPath: path.join(dir, LOCK_FILENAME) };
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = () => true;
    try {
      releaseLock(fakeHandle);
      expect(fs.existsSync(fakeHandle.lockPath)).toBe(true);
    } finally {
      process.stderr.write = orig;
    }
  });
});

describe('withLock + withLockSync', () => {
  it('withLock acquires, runs fn, releases on normal completion', async () => {
    const dir = mkGoalDir();
    let fnRan = false;
    const result = await withLock(dir, 'work', {}, async (handle) => {
      fnRan = true;
      expect(fs.existsSync(handle.lockPath)).toBe(true);
      return 42;
    });
    expect(fnRan).toBe(true);
    expect(result).toBe(42);
    expect(fs.existsSync(path.join(dir, LOCK_FILENAME))).toBe(false);
  });

  it('withLock releases on thrown exception', async () => {
    const dir = mkGoalDir();
    await expect(
      withLock(dir, 'work', {}, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(fs.existsSync(path.join(dir, LOCK_FILENAME))).toBe(false);
  });

  it('withLockSync acquires, runs fn, releases', () => {
    const dir = mkGoalDir();
    let fnRan = false;
    const result = withLockSync(dir, 'work', {}, () => {
      fnRan = true;
      return 'sync';
    });
    expect(fnRan).toBe(true);
    expect(result).toBe('sync');
    expect(fs.existsSync(path.join(dir, LOCK_FILENAME))).toBe(false);
  });
});

describe('default TTL constant', () => {
  it('is 30 seconds per ADR-0002', () => {
    expect(DEFAULT_TTL_SECONDS).toBe(30);
  });
});
