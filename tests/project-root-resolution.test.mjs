/**
 * Regression tests for `engine/project-root.mjs::resolveProjectRoot`.
 *
 * Context: user-reported 2026-05-11 — Claude Desktop sometimes fans out
 * Stop/SessionStart hook calls for multiple open session tabs from a single
 * host process, all carrying that host's initial `process.cwd()`. Result:
 * one project's `.claude/goals/active/` continuation prompt leaks into
 * every other tab. Fix: prefer `stdin.cwd` (Claude Code's canonical
 * per-event project dir) over `process.cwd()`, with strict validation +
 * fallback.
 *
 * The contract:
 *   1. `stdin.cwd` present, absolute, real directory → use it (normalized).
 *   2. `stdin.cwd` missing / empty / null / wrong type → fallback.
 *   3. `stdin.cwd` not absolute → fallback (defensive — would re-introduce
 *      the leak if resolved against host cwd).
 *   4. `stdin.cwd` absolute but path doesn't exist → fallback.
 *   5. `stdin.cwd` absolute but points at a regular file, not a dir → fallback.
 *   6. `stdin` itself missing / null / non-object → fallback.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveProjectRoot } from '../engine/project-root.mjs';

function mkTmpDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `gm-projectroot-${label}-`));
}

const FALLBACK = '/some/fallback/dir';
// Tests inject a no-op stderr writer so warnings don't pollute output.
const deps = (fallbackCwd = FALLBACK) => ({ fs, path, fallbackCwd, stderrWrite: () => {} });

describe('resolveProjectRoot — happy path: stdin.cwd preferred', () => {
  it('returns stdin.cwd verbatim when absolute + real directory', () => {
    const dir = mkTmpDir('happy');
    expect(resolveProjectRoot({ cwd: dir }, deps())).toBe(path.resolve(dir));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('normalizes trailing slashes', () => {
    const dir = mkTmpDir('trailing');
    const out = resolveProjectRoot({ cwd: dir + '/' }, deps());
    expect(out).toBe(path.resolve(dir));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('normalizes // and .. segments', () => {
    const parent = mkTmpDir('nested');
    const child = path.join(parent, 'child');
    fs.mkdirSync(child);
    const messy = `${parent}//child/../child`;
    const out = resolveProjectRoot({ cwd: messy }, deps());
    expect(out).toBe(path.resolve(child));
    fs.rmSync(parent, { recursive: true, force: true });
  });
});

describe('resolveProjectRoot — fallback cases', () => {
  it('falls back when stdin is null', () => {
    expect(resolveProjectRoot(null, deps())).toBe(FALLBACK);
  });

  it('falls back when stdin is undefined', () => {
    expect(resolveProjectRoot(undefined, deps())).toBe(FALLBACK);
  });

  it('falls back when stdin is not an object (string)', () => {
    expect(resolveProjectRoot('not-an-object', deps())).toBe(FALLBACK);
  });

  it('falls back when stdin.cwd is missing', () => {
    expect(resolveProjectRoot({}, deps())).toBe(FALLBACK);
  });

  it('falls back when stdin.cwd is null', () => {
    expect(resolveProjectRoot({ cwd: null }, deps())).toBe(FALLBACK);
  });

  it('falls back when stdin.cwd is empty string', () => {
    expect(resolveProjectRoot({ cwd: '' }, deps())).toBe(FALLBACK);
  });

  it('falls back when stdin.cwd is non-string (number)', () => {
    expect(resolveProjectRoot({ cwd: 42 }, deps())).toBe(FALLBACK);
  });

  it('falls back when stdin.cwd is non-string (object)', () => {
    expect(resolveProjectRoot({ cwd: { not: 'a string' } }, deps())).toBe(FALLBACK);
  });

  it('falls back when stdin.cwd is relative (./foo)', () => {
    expect(resolveProjectRoot({ cwd: './some/relative' }, deps())).toBe(FALLBACK);
  });

  it('falls back when stdin.cwd is relative (foo/bar)', () => {
    expect(resolveProjectRoot({ cwd: 'foo/bar' }, deps())).toBe(FALLBACK);
  });

  it('falls back when stdin.cwd points at a non-existent absolute path', () => {
    expect(resolveProjectRoot({ cwd: '/definitely/does/not/exist/anywhere' }, deps())).toBe(FALLBACK);
  });

  it('falls back when stdin.cwd points at a regular file, not a directory', () => {
    const dir = mkTmpDir('isfile');
    const filePath = path.join(dir, 'a-file.txt');
    fs.writeFileSync(filePath, 'hello');
    expect(resolveProjectRoot({ cwd: filePath }, deps())).toBe(FALLBACK);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('resolveProjectRoot — cross-project leakage fix', () => {
  it('uses stdin.cwd even when fallbackCwd is a completely different real dir', () => {
    // Simulates the bug: Desktop fans out the hook with process.cwd()=projectA
    // but stdin.cwd=projectB. We must use projectB.
    const projectA = mkTmpDir('A');
    const projectB = mkTmpDir('B');

    const out = resolveProjectRoot(
      { cwd: projectB },
      { fs, path, fallbackCwd: projectA },
    );

    expect(out).toBe(path.resolve(projectB));
    expect(out).not.toBe(path.resolve(projectA));

    fs.rmSync(projectA, { recursive: true, force: true });
    fs.rmSync(projectB, { recursive: true, force: true });
  });

  it('does not silently leak when stdin.cwd is invalid — uses fallback', () => {
    const projectA = mkTmpDir('A');
    const out = resolveProjectRoot(
      { cwd: '/nope/not/real' },
      { fs, path, fallbackCwd: projectA },
    );
    expect(out).toBe(projectA);
    fs.rmSync(projectA, { recursive: true, force: true });
  });
});
