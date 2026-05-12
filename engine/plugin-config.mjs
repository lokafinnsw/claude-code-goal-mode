/**
 * Plugin config loader. Per-user file at ~/.claude/plugins/goal-mode/config.json,
 * per-project file at <projectRoot>/.claude/goals/active/config.json. Project
 * keys override user keys.
 *
 * Schema (v3.0.4):
 *   schema_version: 1
 *   stopHookDriver: boolean (default true — auto-drive is the product value)
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
  // v3.0.4: auto-drive is the default. The product value is "walk away
  // for hours and come back to a finished feature" — that requires
  // Stop-hook to keep firing continuation prompts. Setting this to
  // false (hint-only mode) is opt-in for users who want to drive
  // explicitly via /goal-mode:goal-current + evidence-add + achieve
  // CLI verbs, or who have a controller agent with memory rules
  // forbidding engagement. Safety nets (auto-paused-on-silence,
  // stale-review-pending detector) still apply.
  stopHookDriver: true,
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
