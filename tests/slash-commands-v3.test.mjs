import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENV = { ...process.env, CLAUDE_PLUGIN_ROOT: ROOT };

describe('v3 slash command shims', () => {
  const shims = [
    'evidence-add.sh',
    'achieve.sh',
    'submit-verdict.sh',
    'current.sh',
  ];

  for (const shim of shims) {
    const shimPath = path.join(ROOT, 'scripts', shim);

    it(`${shim} exists and is executable`, () => {
      expect(fs.existsSync(shimPath)).toBe(true);
      const mode = fs.statSync(shimPath).mode;
      // owner exec bit set
      expect(mode & 0o100).toBe(0o100);
    });
  }

  it('evidence-add.sh forwards exit 2 on missing args', () => {
    const r = spawnSync(path.join(ROOT, 'scripts', 'evidence-add.sh'), [], { env: ENV });
    expect(r.status).toBe(2);
  });

  it('achieve.sh forwards exit 1 on no active goal (cwd has no .claude)', () => {
    // Run in tmpdir with no goal
    const tmp = fs.mkdtempSync(path.join(ROOT, '..', 'slash-smoke-'));
    try {
      const r = spawnSync(path.join(ROOT, 'scripts', 'achieve.sh'), [], { env: ENV, cwd: tmp });
      // achieve with no goal exits 1 (precondition fail) or 2 (in case of unknown-arg path). Just verify non-zero.
      expect(r.status).not.toBe(0);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('submit-verdict.sh forwards exit 2 on missing --agent', () => {
    const r = spawnSync(path.join(ROOT, 'scripts', 'submit-verdict.sh'), ['--status', 'GO'], { env: ENV });
    expect(r.status).toBe(2);
  });

  it('current.sh forwards exit 2 on unknown flag', () => {
    const r = spawnSync(path.join(ROOT, 'scripts', 'current.sh'), ['--bogus'], { env: ENV });
    expect(r.status).toBe(2);
  });
});
