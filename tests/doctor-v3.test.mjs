import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkExplicitCliMode } from '../engine/doctor.mjs';

const tmpDirs = [];
afterEach(() => {
  for (const d of tmpDirs) try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
  tmpDirs.length = 0;
});

function mkRoot() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-v3-'));
  tmpDirs.push(d);
  return d;
}

describe('doctor checkExplicitCliMode', () => {
  it('returns ok when no config exists (v3.0.4 auto-drive default)', () => {
    const root = mkRoot();
    const r = checkExplicitCliMode(root);
    expect(r.status).toBe('ok');
    expect(r.severity).toBe('info');
    expect(r.message).toMatch(/auto-drive/);
    expect(r.fix).toBeNull();
  });

  it('returns ok when stopHookDriver=true (explicit, matches default)', () => {
    const root = mkRoot();
    fs.mkdirSync(path.join(root, '.claude', 'goals', 'active'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.claude', 'goals', 'active', 'config.json'),
      JSON.stringify({ schema_version: 1, stopHookDriver: true }),
    );
    const r = checkExplicitCliMode(root);
    expect(r.status).toBe('ok');
    expect(r.message).toMatch(/auto-drive/);
  });

  it('returns warn when stopHookDriver=false (per-project opt-in to hint-only)', () => {
    const root = mkRoot();
    fs.mkdirSync(path.join(root, '.claude', 'goals', 'active'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.claude', 'goals', 'active', 'config.json'),
      JSON.stringify({ schema_version: 1, stopHookDriver: false }),
    );
    const r = checkExplicitCliMode(root);
    expect(r.status).toBe('warn');
    expect(r.severity).toBe('warn');
    expect(r.message).toMatch(/explicit-CLI mode/i);
    expect(r.message).toMatch(/config\.json/);
    expect(r.fix).toMatch(/stopHookDriver/);
  });

  it('check has the expected id field', () => {
    const root = mkRoot();
    const r = checkExplicitCliMode(root);
    expect(r.id).toBe('explicit-cli-mode');
  });
});
