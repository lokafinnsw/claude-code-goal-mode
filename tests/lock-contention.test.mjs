/**
 * Cross-process lock contention tests.
 *
 * Why subprocess: the lock primitive's PID-liveness check is meaningful
 * only between distinct processes. In-process tests verify the protocol;
 * these tests verify the OS-level atomicity guarantee (O_EXCL semantics
 * across PIDs).
 *
 * Strategy: spawn N short-lived Node subprocesses, each tries to acquire
 * the same goal-dir lock, record the timestamp at which they succeeded.
 * Assert serialization: no two intervals overlap.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const REPO = path.resolve(fileURLToPath(import.meta.url), '..', '..');

function mkGoalDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lock-contention-'));
}

/**
 * Spawn a Node subprocess that acquires the lock, sleeps holdMs, releases,
 * and prints { pid, acquired_at, released_at } JSON to stdout. Returns a
 * promise resolving to that record.
 */
function spawnAcquirer(goalDir, intent, holdMs) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [
      '--input-type=module',
      '-e',
      `
        import { acquireLock, releaseLock } from '${path.join(REPO, 'engine/lock.mjs').replace(/\\\\/g, '/')}';
        const startWaiting = new Date().toISOString();
        const handle = await acquireLock('${goalDir.replace(/\\\\/g, '/')}', '${intent}', { timeoutMs: 10_000 });
        const acquired = new Date().toISOString();
        await new Promise(r => setTimeout(r, ${holdMs}));
        const released = new Date().toISOString();
        releaseLock(handle);
        process.stdout.write(JSON.stringify({ pid: process.pid, startWaiting, acquired, released }) + '\\n');
      `,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    let out = '';
    let err = '';
    child.stdout.on('data', (b) => { out += b.toString(); });
    child.stderr.on('data', (b) => { err += b.toString(); });
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`subprocess exit=${code}: stderr=${err}`));
        return;
      }
      try {
        resolve(JSON.parse(out.trim().split('\n').pop()));
      } catch (e) {
        reject(new Error(`failed to parse subprocess stdout: ${out}\nstderr: ${err}`));
      }
    });
  });
}

describe('multi-process lock contention', () => {
  it('two concurrent acquirers serialize: no overlapping hold intervals', async () => {
    const dir = mkGoalDir();
    // Both start at roughly the same time; each holds for 200ms.
    const [a, b] = await Promise.all([
      spawnAcquirer(dir, 'process-a', 200),
      spawnAcquirer(dir, 'process-b', 200),
    ]);
    expect(a.pid).not.toBe(b.pid);
    const aAcq = new Date(a.acquired).getTime();
    const aRel = new Date(a.released).getTime();
    const bAcq = new Date(b.acquired).getTime();
    const bRel = new Date(b.released).getTime();
    // Either A entirely before B, or B entirely before A. No interleave.
    const aFirst = aRel <= bAcq;
    const bFirst = bRel <= aAcq;
    expect(aFirst || bFirst).toBe(true);
  }, 20_000);

  it('three concurrent acquirers all eventually succeed in some order', async () => {
    const dir = mkGoalDir();
    const results = await Promise.all([
      spawnAcquirer(dir, 'p1', 100),
      spawnAcquirer(dir, 'p2', 100),
      spawnAcquirer(dir, 'p3', 100),
    ]);
    const pids = new Set(results.map((r) => r.pid));
    expect(pids.size).toBe(3);
    // After all complete, lock file is gone.
    expect(fs.existsSync(path.join(dir, '.lock'))).toBe(false);
  }, 20_000);

  it('subprocess that crashes mid-hold leaves a stale lock; next acquirer breaks it', async () => {
    const dir = mkGoalDir();
    const crasher = spawn('node', [
      '--input-type=module',
      '-e',
      `
        import { acquireLock } from '${path.join(REPO, 'engine/lock.mjs').replace(/\\\\/g, '/')}';
        await acquireLock('${dir.replace(/\\\\/g, '/')}', 'crasher', {});
        process.stdout.write('acquired\\n');
        process.kill(process.pid, 'SIGKILL');
      `,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    await new Promise((resolve) => {
      crasher.stdout.on('data', (b) => {
        if (b.toString().includes('acquired')) resolve(null);
      });
    });
    // Wait for the subprocess to actually die.
    await new Promise((r) => setTimeout(r, 300));
    // Lock file should still be on disk (crasher couldn't release).
    expect(fs.existsSync(path.join(dir, '.lock'))).toBe(true);

    // Now acquire from this process; should break the stale lock.
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = () => true;
    try {
      const { acquireLock, releaseLock } = await import('../engine/lock.mjs');
      const handle = await acquireLock(dir, 'recovery', { timeoutMs: 5000 });
      expect(handle.info.intent).toBe('recovery');
      releaseLock(handle);
    } finally {
      process.stderr.write = origWrite;
    }
  }, 20_000);
});
