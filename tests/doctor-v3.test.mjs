import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkLegacyStopHookDriver } from '../engine/doctor.mjs';

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

describe('doctor checkLegacyStopHookDriver', () => {
  it('returns ok when driver disabled (v3 default)', () => {
    const root = mkRoot();
    const r = checkLegacyStopHookDriver(root);
    expect(r.status).toBe('ok');
    expect(r.message).toMatch(/v3 hint-only/);
  });

  it('returns warn when stopHookDriver=true (per-project)', () => {
    const root = mkRoot();
    fs.mkdirSync(path.join(root, '.claude', 'goals', 'active'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.claude', 'goals', 'active', 'config.json'),
      JSON.stringify({ schema_version: 1, stopHookDriver: true }),
    );
    const r = checkLegacyStopHookDriver(root);
    expect(r.status).toBe('warn');
    expect(r.message).toMatch(/legacy v2 driver/i);
    expect(r.message).toMatch(/config\.json/);
  });

  it('check has the expected name field', () => {
    const root = mkRoot();
    const r = checkLegacyStopHookDriver(root);
    expect(r.name).toBe('legacy-stop-hook-driver');
  });
});
