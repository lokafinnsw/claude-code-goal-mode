/**
 * Plugin config loader. Per-user file at ~/.claude/plugins/goal-mode/config.json,
 * per-project file at <projectRoot>/.claude/goals/active/config.json. Project
 * keys override user keys.
 *
 * Schema (v3.0.5):
 *   schema_version: 1
 *   stopHookDriver: boolean (default true — auto-drive is the product value)
 *   silenceThreshold: int  (default 20)
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
  // v3.0.5: raised from 5 to 20. Auto-pause-on-silence is an early-
  // warning safety net layered on top of triple-budget (iterations,
  // tokens, wallclock). The 5-turn threshold (v2.0.6) was calibrated
  // for the degenerate "controller refuses to engage" case; for
  // production autonomous runs, exploration phases legitimately span
  // 5-15 turns without tag emission. 20 strikes the balance: catches
  // real silence (controller stuck) without false-positives on
  // exploration. Users can override per-project / per-user.
  silenceThreshold: 20,
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
