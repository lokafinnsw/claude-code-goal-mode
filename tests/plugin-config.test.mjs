import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadPluginConfig, PLUGIN_CONFIG_DEFAULTS } from '../engine/plugin-config.mjs';

const tmpDirs = [];
afterEach(() => {
  for (const d of tmpDirs) try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
  tmpDirs.length = 0;
});

function mkTmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-'));
  tmpDirs.push(d);
  return d;
}

describe('loadPluginConfig', () => {
  it('returns v3 defaults when no files exist', () => {
    const root = mkTmp();
    const homeDir = mkTmp();
    const cfg = loadPluginConfig(root, { homeDir });
    expect(cfg.stopHookDriver).toBe(true);  // v3.0.4: auto-drive default
    expect(cfg.silenceThreshold).toBeUndefined();  // v3.0.7: removed
    expect(cfg.schema_version).toBe(1);
  });

  it('reads per-user config when present', () => {
    const root = mkTmp();
    const homeDir = mkTmp();
    fs.mkdirSync(path.join(homeDir, '.claude', 'plugins', 'goal-mode'), { recursive: true });
    fs.writeFileSync(
      path.join(homeDir, '.claude', 'plugins', 'goal-mode', 'config.json'),
      JSON.stringify({ schema_version: 1, stopHookDriver: true }),
    );
    const cfg = loadPluginConfig(root, { homeDir });
    expect(cfg.stopHookDriver).toBe(true);
    expect(cfg.silenceThreshold).toBeUndefined();  // v3.0.7: removed
  });

  it('reads per-project config when present (no user config)', () => {
    const root = mkTmp();
    const homeDir = mkTmp();
    fs.mkdirSync(path.join(root, '.claude', 'goals', 'active'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.claude', 'goals', 'active', 'config.json'),
      JSON.stringify({ schema_version: 1, stopHookDriver: true }),
    );
    const cfg = loadPluginConfig(root, { homeDir });
    expect(cfg.stopHookDriver).toBe(true);
  });

  it('per-project overrides per-user (project wins on collision)', () => {
    const root = mkTmp();
    const homeDir = mkTmp();
    fs.mkdirSync(path.join(homeDir, '.claude', 'plugins', 'goal-mode'), { recursive: true });
    fs.writeFileSync(
      path.join(homeDir, '.claude', 'plugins', 'goal-mode', 'config.json'),
      JSON.stringify({ schema_version: 1, stopHookDriver: true }),
    );
    fs.mkdirSync(path.join(root, '.claude', 'goals', 'active'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.claude', 'goals', 'active', 'config.json'),
      JSON.stringify({ schema_version: 1, stopHookDriver: false }),
    );
    const cfg = loadPluginConfig(root, { homeDir });
    expect(cfg.stopHookDriver).toBe(false);
  });

  it('preserves unknown keys (forward-compat)', () => {
    const root = mkTmp();
    const homeDir = mkTmp();
    fs.mkdirSync(path.join(root, '.claude', 'goals', 'active'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.claude', 'goals', 'active', 'config.json'),
      JSON.stringify({ schema_version: 1, futureOption: 'xyz' }),
    );
    const cfg = loadPluginConfig(root, { homeDir });
    expect(cfg.futureOption).toBe('xyz');
  });

  it('malformed JSON falls back to defaults silently', () => {
    const root = mkTmp();
    const homeDir = mkTmp();
    fs.mkdirSync(path.join(root, '.claude', 'goals', 'active'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.claude', 'goals', 'active', 'config.json'),
      'not valid json{{{',
    );
    const cfg = loadPluginConfig(root, { homeDir });
    expect(cfg.stopHookDriver).toBe(true);  // v3.0.4 default preserved
  });

  it('exposes frozen PLUGIN_CONFIG_DEFAULTS', () => {
    expect(PLUGIN_CONFIG_DEFAULTS.stopHookDriver).toBe(true);  // v3.0.4
    expect(Object.isFrozen(PLUGIN_CONFIG_DEFAULTS)).toBe(true);
  });

  it('partial config merges with defaults (no replace)', () => {
    // v3.0.7: silenceThreshold was removed as a known field; loader still
    // preserves unknown keys verbatim, so a stale config like
    // `{ silenceThreshold: 10 }` is round-tripped without affecting defaults.
    const root = mkTmp();
    const homeDir = mkTmp();
    fs.mkdirSync(path.join(root, '.claude', 'goals', 'active'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.claude', 'goals', 'active', 'config.json'),
      JSON.stringify({ silenceThreshold: 10 }),
    );
    const cfg = loadPluginConfig(root, { homeDir });
    expect(cfg.silenceThreshold).toBe(10);  // forward-compat preserves unknown key
    expect(cfg.stopHookDriver).toBe(true);  // v3.0.4 default preserved
  });

  it('explicit stopHookDriver=false in project config overrides default (opt-in hint-only)', () => {
    const root = mkTmp();
    const homeDir = mkTmp();
    fs.mkdirSync(path.join(root, '.claude', 'goals', 'active'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.claude', 'goals', 'active', 'config.json'),
      JSON.stringify({ schema_version: 1, stopHookDriver: false }),
    );
    const cfg = loadPluginConfig(root, { homeDir });
    expect(cfg.stopHookDriver).toBe(false);  // explicit opt-out from default
  });
});
