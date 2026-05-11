/**
 * Doctor — health diagnostics for goal-mode.
 *
 * One-shot command that surfaces every non-obvious failure mode with a concrete
 * fix per check. Designed to answer "why is goal-mode behaving weird?" without
 * requiring the user to manually grep state.json / installed_plugins.json /
 * .claude/plugins/cache.
 *
 * Each check is a pure function `(projectRoot, env) -> DiagnosticCheck`. The
 * runDoctor orchestrator catches per-check exceptions so one bad check never
 * breaks the rest of the report.
 *
 * Surface contract:
 *   - DiagnosticCheckSchema (zod): id, severity, status, message, fix
 *   - CHECKS: registry of named checks (id -> check fn)
 *   - runDoctor(projectRoot, env?) -> DoctorReport
 *
 * The CLI wrapper in doctor-cli.mjs renders the report for terminal output;
 * the slash-command markdown invokes the bash shim that calls the CLI.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { z } from 'zod';
import { activeDir, statePath, treePath } from './paths.mjs';
import {
  loadState,
  loadTree,
  loadStateFromEvents as _loadStateFromEvents,
  GoalStateSchema,
  GoalTreeSchema,
} from './state.mjs';
import { CURRENT_SCHEMA_VERSION } from './migrations.mjs';
import { findNodeById } from './traversal.mjs';
import { readEvents, eventsPath } from './event-log.mjs';
import semver from 'semver';

// Public schema -----------------------------------------------------------

export const SeveritySchema = z.enum(['info', 'warn', 'error']);
export const StatusSchema = z.enum(['ok', 'warn', 'fail']);

export const DiagnosticCheckSchema = z.object({
  id: z.string().min(1),
  severity: SeveritySchema,
  status: StatusSchema,
  message: z.string().min(1),
  fix: z.string().nullable(),
});

export const DoctorReportSchema = z.object({
  checks: z.array(DiagnosticCheckSchema),
  summary: z.object({
    ok: z.number().int().nonnegative(),
    warn: z.number().int().nonnegative(),
    fail: z.number().int().nonnegative(),
  }),
  exitCode: z.union([z.literal(0), z.literal(1)]),
});

// Helpers -----------------------------------------------------------------

function ok(id, message) {
  return { id, severity: 'info', status: 'ok', message, fix: null };
}
function warn(id, message, fix = null) {
  return { id, severity: 'warn', status: 'warn', message, fix };
}
function fail(id, message, fix = null) {
  return { id, severity: 'error', status: 'fail', message, fix };
}

// Individual checks --------------------------------------------------------

/**
 * state.json exists and parses against GoalStateSchema.
 */
export function checkStateLoadable(projectRoot) {
  const id = 'state-loadable';
  const sp = statePath(projectRoot);
  if (!fs.existsSync(sp)) {
    return ok(id, 'no active state.json (no goal active in this project)');
  }
  try {
    const raw = fs.readFileSync(sp, 'utf8');
    const parsed = JSON.parse(raw);
    GoalStateSchema.parse(parsed);
    return ok(id, 'state.json loads and validates');
  } catch (err) {
    return fail(
      id,
      `state.json fails to load: ${err.message}`,
      `inspect ${sp} and the .broken-* backups in the same directory; restore from a backup or run /goal-mode:goal-clear`,
    );
  }
}

/**
 * tree.json exists and parses against GoalTreeSchema.
 */
export function checkTreeLoadable(projectRoot) {
  const id = 'tree-loadable';
  const tp = treePath(projectRoot);
  if (!fs.existsSync(tp)) {
    return ok(id, 'no active tree.json (no goal active in this project)');
  }
  try {
    const raw = fs.readFileSync(tp, 'utf8');
    const parsed = JSON.parse(raw);
    GoalTreeSchema.parse(parsed);
    return ok(id, 'tree.json loads and validates');
  } catch (err) {
    return fail(
      id,
      `tree.json fails to load: ${err.message}`,
      `inspect ${tp} and any .broken-* backups; restore or regenerate via /goal-mode:goal-plan-from-file`,
    );
  }
}

/**
 * schema_version on state and tree matches the engine's CURRENT_SCHEMA_VERSION.
 * After v1.2.0 ships migrations.mjs, this will use that constant; for now we
 * accept any explicit literal accepted by the live schema (1).
 */
export function checkSchemaVersionCurrent(projectRoot, env = process.env) {
  const id = 'schema-version-current';
  const state = loadState(projectRoot);
  const tree = loadTree(projectRoot);
  if (!state && !tree) return ok(id, 'no goal active — nothing to version-check');
  const supported = env.GOAL_MODE_SUPPORTED_SCHEMA
    ? env.GOAL_MODE_SUPPORTED_SCHEMA.split(',').map((s) => Number(s.trim()))
    : [CURRENT_SCHEMA_VERSION];
  const offenders = [];
  if (state && !supported.includes(state.schema_version)) {
    offenders.push(`state.schema_version=${state.schema_version}`);
  }
  if (tree && !supported.includes(tree.schema_version)) {
    offenders.push(`tree.schema_version=${tree.schema_version}`);
  }
  if (offenders.length === 0) {
    return ok(id, `schema_version current (supported=[${supported.join(',')}])`);
  }
  return fail(
    id,
    `schema_version mismatch: ${offenders.join(', ')}`,
    'run /goal-mode:goal-doctor --auto-migrate (after v1.2.0 epic-2 lands) or jq-patch schema_version manually after reviewing engine/state.mjs schemas',
  );
}

/**
 * No leftover .broken-* backups in active/. Their existence indicates a past
 * load failure that the user may not have noticed.
 */
export function checkNoBrokenBackups(projectRoot) {
  const id = 'no-broken-backups';
  const dir = activeDir(projectRoot);
  if (!fs.existsSync(dir)) return ok(id, 'no active dir (no goal active)');
  const broken = fs
    .readdirSync(dir)
    .filter((f) => f.includes('.broken-'));
  if (broken.length === 0) return ok(id, 'no .broken-* backups present');
  return warn(
    id,
    `${broken.length} .broken-* backup(s) found in ${dir}: ${broken.slice(0, 3).join(', ')}${broken.length > 3 ? ` and ${broken.length - 3} more` : ''}`,
    `inspect each backup against the current state.json; if recovery is not needed, delete with: rm "${dir}"/*.broken-*`,
  );
}

/**
 * state.cursor points at a node that exists in tree.
 */
export function checkCursorResolves(projectRoot) {
  const id = 'cursor-resolves-in-tree';
  const state = loadState(projectRoot);
  const tree = loadTree(projectRoot);
  if (!state || !tree) return ok(id, 'no goal active — cursor check skipped');
  const node = findNodeById(tree, state.cursor);
  if (node) return ok(id, `cursor "${state.cursor}" resolves to ${node.type} node "${node.title}"`);
  return fail(
    id,
    `cursor "${state.cursor}" does not exist in tree`,
    'run /goal-mode:goal-status to inspect tree, then jq-patch state.json cursor to a real node id, or /goal-mode:goal-clear and re-plan',
  );
}

/**
 * Plugin pin in installed_plugins.json points at the highest semver in cache.
 */
export function checkPluginPinCurrent(projectRoot, env = process.env) {
  const id = 'plugin-pin-current';
  const home = env.HOME || os.homedir();
  const installedPath = path.join(home, '.claude', 'plugins', 'installed_plugins.json');
  if (!fs.existsSync(installedPath)) {
    return warn(
      id,
      'installed_plugins.json missing — plugin loader may default to a fallback',
      'run bash install.sh from the goal-mode repo to register and pin the current version',
    );
  }
  let installed;
  try {
    installed = JSON.parse(fs.readFileSync(installedPath, 'utf8'));
  } catch (err) {
    return fail(id, `installed_plugins.json invalid JSON: ${err.message}`, 'restore from a backup or re-run install.sh');
  }
  const entry = installed?.plugins?.['goal-mode@goal-mode']?.[0];
  if (!entry) return ok(id, 'goal-mode not pinned (likely not installed yet)');
  const pinnedVersion = entry.version;
  const cacheRoot = path.join(home, '.claude', 'plugins', 'cache', 'goal-mode', 'goal-mode');
  if (!fs.existsSync(cacheRoot)) return ok(id, `pinned ${pinnedVersion}; cache dir missing (clean install)`);
  const versions = fs
    .readdirSync(cacheRoot)
    .filter((d) => semver.valid(d) !== null)
    .sort(semver.rcompare); // descending; handles pre-release tags correctly
  if (versions.length === 0) return ok(id, `pinned ${pinnedVersion}; no cached versions to compare`);
  const latest = versions[0];
  if (semver.eq(latest, pinnedVersion)) return ok(id, `pin matches latest cached version (${pinnedVersion})`);
  if (semver.lt(latest, pinnedVersion)) {
    return ok(id, `pinned ${pinnedVersion} is newer than any cached version (${latest})`);
  }
  return warn(
    id,
    `pinned ${pinnedVersion} but cache has newer version ${latest}`,
    `run bash install.sh from the goal-mode repo to update pin to ${latest}, then restart Claude Desktop / reload-plugins in CLI`,
  );
}

/**
 * Stop hook fired recently (< 24h ago) if goal is pursuing — proxy for
 * "engine is actually running". When goal is paused or no goal exists, skip.
 */
export function checkStopHookFiredRecently(projectRoot, env = process.env) {
  const id = 'stop-hook-fired-recently';
  const state = loadState(projectRoot);
  if (!state) return ok(id, 'no goal active');
  if (state.lifecycle !== 'pursuing') return ok(id, `lifecycle=${state.lifecycle}, no firing expected`);
  // Proxy: state.json mtime (last save). Stop hook saves state on every fire.
  const sp = statePath(projectRoot);
  const stat = fs.statSync(sp);
  const ageMs = Date.now() - stat.mtimeMs;
  const ageH = ageMs / 3_600_000;
  if (ageH < 24) return ok(id, `state.json last saved ${ageH.toFixed(1)}h ago — engine appears live`);
  return warn(
    id,
    `state.json last saved ${ageH.toFixed(1)}h ago — Stop hook may not be firing`,
    'verify hooks/hooks.json declares Stop entry and ~/.claude/settings.json has goal-mode in enabledPlugins; check stderr in Claude Code log for engine errors',
  );
}

/**
 * Budget headroom: warn at 75%, fail at 95%.
 */
export function checkBudgetHeadroom(projectRoot) {
  const id = 'budget-headroom';
  const state = loadState(projectRoot);
  if (!state) return ok(id, 'no goal active');
  // Bug I10 fix: budget headroom check makes no sense for non-pursuing
  // goals — the counters are historical, the goal is no longer consuming
  // budget. Pre-v2.0.3 this surfaced "wallclock budget 277% used" as
  // FAIL even though the goal achieved a day ago. Lifecycle-aware skip
  // restores signal-to-noise.
  if (state.lifecycle !== 'pursuing') {
    return ok(
      id,
      `lifecycle=${state.lifecycle}; budget counters are historical (not actionable)`,
    );
  }
  const checks = [];
  for (const [kind, b] of [
    ['iterations', state.budget.iterations],
    ['tokens', state.budget.tokens],
  ]) {
    if (b.max <= 0) continue; // 0 = unlimited
    const pct = (b.used / b.max) * 100;
    checks.push({ kind, pct, used: b.used, max: b.max });
  }
  const wallElapsedSec = (Date.now() - new Date(state.budget.wallclock.started_at).getTime()) / 1000;
  if (state.budget.wallclock.max_seconds > 0) {
    checks.push({
      kind: 'wallclock',
      pct: (wallElapsedSec / state.budget.wallclock.max_seconds) * 100,
      used: Math.round(wallElapsedSec),
      max: state.budget.wallclock.max_seconds,
    });
  }
  const tightest = checks.reduce((a, b) => (b.pct > a.pct ? b : a), { pct: 0, kind: 'none' });
  if (tightest.pct >= 95) {
    return fail(
      id,
      `${tightest.kind} budget ${tightest.pct.toFixed(1)}% used (${tightest.used}/${tightest.max})`,
      'goal will hit budget-limited soon; consider /goal-mode:goal-pause and reviewing whether scope can be reduced',
    );
  }
  if (tightest.pct >= 75) {
    return warn(
      id,
      `${tightest.kind} budget ${tightest.pct.toFixed(1)}% used (${tightest.used}/${tightest.max})`,
      'plan compaction or reducing remaining task scope before budget exhaustion',
    );
  }
  return ok(id, `budgets healthy (tightest: ${tightest.kind} at ${tightest.pct.toFixed(1)}%)`);
}

// Auto-fix implementations -----------------------------------------------
// Each fix returns { ran: true|false, message: string }. Only invoked when
// the user explicitly opts in via `doctor --fix`. Failures NEVER throw —
// auto-fix is best-effort, the diagnostic remains authoritative.

export const FIXERS = {
  'no-broken-backups': (projectRoot) => {
    const dir = activeDir(projectRoot);
    if (!fs.existsSync(dir)) return { ran: false, message: 'no active dir' };
    const broken = fs.readdirSync(dir).filter((f) => f.includes('.broken-'));
    if (broken.length === 0) return { ran: false, message: 'nothing to delete' };
    let removed = 0;
    for (const f of broken) {
      try { fs.unlinkSync(path.join(dir, f)); removed += 1; } catch (_) {}
    }
    return { ran: removed > 0, message: `deleted ${removed} .broken-* backup(s)` };
  },
  'pre-migration-backup-retention': (projectRoot) => {
    const dir = activeDir(projectRoot);
    if (!fs.existsSync(dir)) return { ran: false, message: 'no active dir' };
    const backups = fs
      .readdirSync(dir)
      .filter((f) => f.includes('.pre-migration-v'))
      .map((f) => ({ f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    if (backups.length <= 3) return { ran: false, message: 'within retention' };
    let removed = 0;
    for (const e of backups.slice(3)) {
      try { fs.unlinkSync(path.join(dir, e.f)); removed += 1; } catch (_) {}
    }
    return { ran: removed > 0, message: `deleted ${removed} oldest pre-migration backup(s), kept 3 newest` };
  },
};

// Registry ----------------------------------------------------------------

/**
 * Cache-vs-event-log drift detection (Phase 7 reader-switch).
 *
 * When event-log is canonical and state.json/tree.json are caches, the
 * cache must stay in sync with replayed-from-events state. Drift indicates:
 *   (a) Manual `jq` patch to state.json that bypassed event emission, OR
 *   (b) Engine crash mid-write that left cache out of date.
 *
 * Either case is a real bug to surface. Check compares `state.cursor` (the
 * most user-visible drift signal) between cache and replay.
 */
export function checkCacheFreshness(projectRoot) {
  const id = 'cache-freshness';
  const sp = statePath(projectRoot);
  const tp = treePath(projectRoot);
  if (!fs.existsSync(sp) && !fs.existsSync(tp)) return ok(id, 'no cache to check (no active goal)');
  const cache = loadState(projectRoot);
  if (!cache) return ok(id, 'state.json missing or unreadable (separate check handles this)');
  const eventsFile = path.join(activeDir(projectRoot), 'events.jsonl');
  if (!fs.existsSync(eventsFile)) return ok(id, 'no event log (legacy v1 mode; cache is authoritative)');
  // Heavy-ish: full replay. Cheap enough on a 200-line log; if perf becomes
  // an issue, switch to a hash-comparison strategy.
  let replayed;
  try {
    // Dynamic import to avoid hard dependency in doctor when run against
    // projects where the v2 modules aren't installed (very edge case).
    // Falls back to "ok unable to verify" on any failure.
    const fn = globalThis._loadStateFromEventsForDoctor;
    if (typeof fn !== 'function') {
      // Default: call the module function directly. We can't `await` here
      // (doctor checks are sync), but loadStateFromEvents is now sync.
      replayed = loadStateFromEventsLazy(projectRoot);
    } else {
      replayed = fn(projectRoot, { writeCache: false });
    }
  } catch (err) {
    return warn(id, `replay verification failed: ${err.message}`, 'inspect events.jsonl for corruption; run /goal-mode:goal-doctor with stderr captured');
  }
  if (!replayed) return ok(id, 'event log present but replay returned null (no events post-skeleton); cache assumed authoritative');
  if (cache.cursor !== replayed.state.cursor) {
    return fail(
      id,
      `cache cursor "${cache.cursor}" ≠ event-log cursor "${replayed.state.cursor}"`,
      'cache is stale relative to event log. Run `node "$CLAUDE_PLUGIN_ROOT"/engine/migrate-v1-to-v2.mjs --force` (regenerates cache from events) OR delete state.json+tree.json then run /goal-mode:goal-status (auto-regenerates).',
    );
  }
  if (cache.lifecycle !== replayed.state.lifecycle) {
    return warn(
      id,
      `cache lifecycle "${cache.lifecycle}" ≠ event-log lifecycle "${replayed.state.lifecycle}"`,
      'minor drift; non-blocking but inspect state.history vs events.jsonl tail',
    );
  }
  return ok(id, `cache in sync with event log (cursor=${cache.cursor}, lifecycle=${cache.lifecycle})`);
}

// Lazy require to avoid a hard dependency cycle in modules that don't need
// the event-sourced read path.
function loadStateFromEventsLazy(projectRoot) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  // Note: ESM has no `require`; use dynamic import in a sync wrapper via
  // import.meta.resolve isn't sync either. We accept this limitation: doctor
  // can't compute drift without async, so we use the live module reference.
  // In practice state.mjs imports this module, so circular at module load.
  // Simplest: import statically at top of doctor.mjs and accept the cycle.
  return _loadStateFromEvents(projectRoot, { writeCache: false });
}

/**
 * v2-migrated status — reports whether this project has been migrated from
 * v1 to v2 (events.jsonl populated) or is still on the legacy state.json
 * canonical-read path.
 */
export function checkV2Migrated(projectRoot) {
  const id = 'v2-migrated';
  const adir = activeDir(projectRoot);
  if (!fs.existsSync(adir)) return ok(id, 'no active goal in this project');
  const hasState = fs.existsSync(statePath(projectRoot));
  const hasTree = fs.existsSync(treePath(projectRoot));
  const hasEvents = fs.existsSync(path.join(adir, 'events.jsonl'));
  if (!hasState && !hasTree && !hasEvents) return ok(id, 'no active goal');
  if (hasEvents && !hasState && !hasTree) {
    return ok(id, 'v2-native: event log only (no legacy JSON cache)');
  }
  if (hasEvents && (hasState || hasTree)) {
    return ok(id, 'v2-migrated: event log populated alongside legacy JSON cache (dual-write rc1 mode)');
  }
  if ((hasState || hasTree) && !hasEvents) {
    return warn(
      id,
      'v1 project not yet migrated — events.jsonl missing',
      'run: node "$CLAUDE_PLUGIN_ROOT"/engine/migrate-v1-to-v2.mjs (idempotent; backups preserved as .pre-v2-migration-<ts>)',
    );
  }
  return ok(id, 'state indeterminate');
}

/**
 * Pre-migration backup retention — warn when more than 3 backups accumulate.
 * Auto-fixable via `doctor --fix` (deletes oldest backups, keeps newest 3).
 */
export function checkPreMigrationBackupRetention(projectRoot) {
  const id = 'pre-migration-backup-retention';
  const dir = activeDir(projectRoot);
  if (!fs.existsSync(dir)) return ok(id, 'no active dir');
  const backups = fs.readdirSync(dir).filter((f) => f.includes('.pre-migration-v'));
  if (backups.length <= 3) return ok(id, `${backups.length} pre-migration backup(s) (within retention of 3)`);
  return warn(
    id,
    `${backups.length} pre-migration backup(s) exceed retention of 3`,
    `run /goal-mode:goal-doctor --fix to delete the ${backups.length - 3} oldest; or manually: rm "${dir}"/*.pre-migration-v* (after triage)`,
  );
}

/**
 * Event log present and growing — proxy for "dual-write is running healthily".
 * When state.json mtime is recent but events.jsonl is missing/empty, the
 * event-log dual-write path may have a permissions issue or be writing to
 * the wrong path.
 */
export function checkEventLogPresent(projectRoot) {
  const id = 'event-log-present';
  const state = loadState(projectRoot);
  if (!state) return ok(id, 'no goal active — event-log check skipped');
  if (state.lifecycle !== 'pursuing') return ok(id, `lifecycle=${state.lifecycle}; event-log not actively written`);
  const events = readEvents(projectRoot);
  if (events.length > 0) return ok(id, `${events.length} event(s) in events.jsonl (dual-write healthy)`);
  // events.jsonl missing or empty while goal pursuing. If the goal has been
  // running for some history-events worth of iterations, this is a warning;
  // for a fresh pursuing goal (iter ≤ 1), informational.
  if (state.budget.iterations.used <= 1) {
    return ok(id, 'events.jsonl not yet populated (fresh goal)');
  }
  return warn(
    id,
    `events.jsonl is empty after ${state.budget.iterations.used} iterations — dual-write may have failed`,
    `check stderr in Claude Code log for "[goal-mode] event-log append failed" lines; verify ${eventsPath(projectRoot)} is writable`,
  );
}

export const CHECKS = {
  'state-loadable': checkStateLoadable,
  'tree-loadable': checkTreeLoadable,
  'schema-version-current': checkSchemaVersionCurrent,
  'no-broken-backups': checkNoBrokenBackups,
  'cursor-resolves-in-tree': checkCursorResolves,
  'plugin-pin-current': checkPluginPinCurrent,
  'stop-hook-fired-recently': checkStopHookFiredRecently,
  'budget-headroom': checkBudgetHeadroom,
  'event-log-present': checkEventLogPresent,
  'pre-migration-backup-retention': checkPreMigrationBackupRetention,
  'v2-migrated': checkV2Migrated,
  'cache-freshness': checkCacheFreshness,
};

// Orchestrator ------------------------------------------------------------

/**
 * Apply auto-fixers for every check that has one. Returns the list of
 * { id, ran, message } records. Caller (CLI) typically follows up with a
 * second runDoctor pass so the report reflects the post-fix state.
 */
export function runFix(projectRoot) {
  const applied = [];
  for (const [id, fixer] of Object.entries(FIXERS)) {
    try {
      const result = fixer(projectRoot);
      applied.push({ id, ran: result.ran, message: result.message });
    } catch (err) {
      applied.push({ id, ran: false, message: `fix threw: ${err.message}` });
    }
  }
  return applied;
}

export function runDoctor(projectRoot, env = process.env) {
  const checks = [];
  for (const [id, fn] of Object.entries(CHECKS)) {
    try {
      const result = fn(projectRoot, env);
      // Defensive: validate the shape of every check result so a buggy check
      // implementation can't poison the report.
      DiagnosticCheckSchema.parse(result);
      checks.push(result);
    } catch (err) {
      checks.push({
        id,
        severity: 'error',
        status: 'fail',
        message: `check threw: ${err.message}`,
        fix: 'inspect engine/doctor.mjs check implementation; this is a goal-mode bug, not a user-state issue',
      });
    }
  }
  const summary = checks.reduce(
    (acc, c) => {
      acc[c.status]++;
      return acc;
    },
    { ok: 0, warn: 0, fail: 0 },
  );
  const exitCode = summary.fail > 0 ? 1 : 0;
  return { checks, summary, exitCode };
}
