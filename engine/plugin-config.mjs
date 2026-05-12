/**
 * Plugin config loader. Per-user file at ~/.claude/plugins/goal-mode/config.json,
 * per-project file at <projectRoot>/.claude/goals/active/config.json. Project
 * keys override user keys.
 *
 * Schema (v3.0):
 *   schema_version: 1
 *   stopHookDriver: boolean (default false — v3 hint-only)
 *   silenceThreshold: int  (default 5)
 *
 * Unknown keys are preserved and returned (forward-compat with v3.1+).
 *
 * Pure read-only — no writes. Never throws (malformed JSON returns null
 * from tryReadJson, which spreads as undefined into defaults).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULTS = Object.freeze({
  schema_version: 1,
  stopHookDriver: false,
  silenceThreshold: 5,
});

function tryReadJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

export function loadPluginConfig(projectRoot, { homeDir = os.homedir() } = {}) {
  const userCfg = tryReadJson(path.join(homeDir, '.claude', 'plugins', 'goal-mode', 'config.json'));
  const projCfg = tryReadJson(path.join(projectRoot, '.claude', 'goals', 'active', 'config.json'));
  return { ...DEFAULTS, ...(userCfg || {}), ...(projCfg || {}) };
}

export const PLUGIN_CONFIG_DEFAULTS = DEFAULTS;
