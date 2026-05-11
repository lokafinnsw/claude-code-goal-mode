import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CHECKS,
  DiagnosticCheckSchema,
  runDoctor,
  checkStateLoadable,
  checkTreeLoadable,
  checkSchemaVersionCurrent,
  checkNoBrokenBackups,
  checkCursorResolves,
  checkPluginPinCurrent,
  checkStopHookFiredRecently,
  checkBudgetHeadroom,
} from '../engine/doctor.mjs';
import { saveState, saveTree } from '../engine/state.mjs';
import { activeDir, statePath, treePath } from '../engine/paths.mjs';

// Test fixtures ----------------------------------------------------------

function mkRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-'));
}

function makeTask(id = 'sprint-1.epic-1.task-1') {
  return {
    id,
    type: 'task',
    title: 't',
    goal: 'g',
    acceptance_criteria: ['ac0'],
    review: [],
    validate: null,
    work_front: null,
    status: 'pending',
    evidence: [],
    blocker_reason: null,
    review_attempts: 0,
    notes: [],
    children: [],
  };
}

function makeTree(taskId = 'sprint-1.epic-1.task-1') {
  return {
    schema_version: 2,
    goal_id: 'g',
    mission: 'm',
    created_at: new Date().toISOString(),
    approved_at: new Date().toISOString(),
    root: {
      id: 'sprint-1',
      type: 'sprint',
      title: 's',
      goal: 'sg',
      acceptance_criteria: ['every child reaches achieved'],
      review: [],
      validate: null,
      work_front: null,
      status: 'pending',
      evidence: [],
      blocker_reason: null,
      review_attempts: 0,
      notes: [],
      children: [
        {
          id: 'sprint-1.epic-1',
          type: 'epic',
          title: 'e',
          goal: 'eg',
          acceptance_criteria: ['every child reaches achieved'],
          review: [],
          validate: null,
          work_front: null,
          status: 'pending',
          evidence: [],
          blocker_reason: null,
          review_attempts: 0,
          notes: [],
          children: [makeTask(taskId)],
        },
      ],
    },
  };
}

function makeState(cursor = 'sprint-1.epic-1.task-1', overrides = {}) {
  return {
    schema_version: 2,
    goal_id: 'g',
    lifecycle: 'pursuing',
    cursor,
    budget: {
      iterations: { used: 0, max: 100 },
      tokens: { used: 0, max: 1_000_000 },
      wallclock: {
        started_at: new Date().toISOString(),
        max_seconds: 86400,
      },
    },
    session_id: 'sess-doctor',
    started_at: new Date().toISOString(),
    paused_at: null,
    ended_at: null,
    ended_reason: null,
    history: [],
    ...overrides,
  };
}

function setupFakeHomeWithCache({ pinned = '1.0.0', cached = ['1.0.0'] } = {}) {
  const home = mkRoot();
  const installedDir = path.join(home, '.claude', 'plugins');
  fs.mkdirSync(installedDir, { recursive: true });
  if (pinned) {
    fs.writeFileSync(
      path.join(installedDir, 'installed_plugins.json'),
      JSON.stringify({
        version: 2,
        plugins: {
          'goal-mode@goal-mode': [
            {
              scope: 'user',
              installPath: `${home}/.claude/plugins/cache/goal-mode/goal-mode/${pinned}`,
              version: pinned,
              installedAt: new Date().toISOString(),
              lastUpdated: new Date().toISOString(),
            },
          ],
        },
      }),
    );
  }
  const cacheDir = path.join(installedDir, 'cache', 'goal-mode', 'goal-mode');
  fs.mkdirSync(cacheDir, { recursive: true });
  for (const v of cached) fs.mkdirSync(path.join(cacheDir, v), { recursive: true });
  return { home, env: { HOME: home } };
}

// Per-check tests --------------------------------------------------------

describe('checkStateLoadable', () => {
  it('returns ok when no state.json exists', () => {
    const root = mkRoot();
    const r = checkStateLoadable(root);
    expect(r.status).toBe('ok');
  });
  it('returns ok when state.json is valid', () => {
    const root = mkRoot();
    saveTree(root, makeTree());
    saveState(root, makeState());
    const r = checkStateLoadable(root);
    expect(r.status).toBe('ok');
  });
  it('returns fail when state.json is malformed JSON', () => {
    const root = mkRoot();
    fs.mkdirSync(activeDir(root), { recursive: true });
    fs.writeFileSync(statePath(root), '{this is not json');
    const r = checkStateLoadable(root);
    expect(r.status).toBe('fail');
    expect(r.fix).toBeTruthy();
  });
});

describe('checkTreeLoadable', () => {
  it('returns ok when no tree.json exists', () => {
    expect(checkTreeLoadable(mkRoot()).status).toBe('ok');
  });
  it('returns ok when tree.json is valid', () => {
    const root = mkRoot();
    saveTree(root, makeTree());
    expect(checkTreeLoadable(root).status).toBe('ok');
  });
  it('returns fail when tree.json is malformed JSON', () => {
    const root = mkRoot();
    fs.mkdirSync(activeDir(root), { recursive: true });
    fs.writeFileSync(treePath(root), 'not-json{');
    const r = checkTreeLoadable(root);
    expect(r.status).toBe('fail');
    expect(r.fix).toBeTruthy();
  });
});

describe('checkSchemaVersionCurrent', () => {
  it('returns ok when no goal active', () => {
    expect(checkSchemaVersionCurrent(mkRoot()).status).toBe('ok');
  });
  it('returns ok when version matches default supported (CURRENT_SCHEMA_VERSION)', () => {
    const root = mkRoot();
    saveTree(root, makeTree());
    saveState(root, makeState());
    expect(checkSchemaVersionCurrent(root).status).toBe('ok');
  });
  it('returns fail when env GOAL_MODE_SUPPORTED_SCHEMA excludes current version', () => {
    const root = mkRoot();
    saveTree(root, makeTree());
    saveState(root, makeState());
    // Use 99,100 so the actual current version (whatever it is) is excluded.
    const r = checkSchemaVersionCurrent(root, { GOAL_MODE_SUPPORTED_SCHEMA: '99,100' });
    expect(r.status).toBe('fail');
  });
});

describe('checkNoBrokenBackups', () => {
  it('returns ok when no broken files', () => {
    const root = mkRoot();
    saveTree(root, makeTree());
    saveState(root, makeState());
    expect(checkNoBrokenBackups(root).status).toBe('ok');
  });
  it('returns warn when .broken-* file present', () => {
    const root = mkRoot();
    saveTree(root, makeTree());
    saveState(root, makeState());
    fs.writeFileSync(
      path.join(activeDir(root), 'state.json.broken-2026-01-01T00-00-00-0'),
      '{}',
    );
    const r = checkNoBrokenBackups(root);
    expect(r.status).toBe('warn');
    expect(r.fix).toContain('.broken-');
  });
});

describe('checkCursorResolves', () => {
  it('returns ok when no goal active', () => {
    expect(checkCursorResolves(mkRoot()).status).toBe('ok');
  });
  it('returns ok when cursor exists in tree', () => {
    const root = mkRoot();
    saveTree(root, makeTree());
    saveState(root, makeState('sprint-1.epic-1.task-1'));
    expect(checkCursorResolves(root).status).toBe('ok');
  });
  it('returns fail when cursor points to nonexistent node', () => {
    const root = mkRoot();
    saveTree(root, makeTree());
    saveState(root, makeState('sprint-9.epic-9.task-9'));
    const r = checkCursorResolves(root);
    expect(r.status).toBe('fail');
    expect(r.fix).toContain('jq-patch');
  });
});

describe('checkPluginPinCurrent', () => {
  it('returns warn when installed_plugins.json missing', () => {
    const home = mkRoot();
    const r = checkPluginPinCurrent(mkRoot(), { HOME: home });
    expect(r.status).toBe('warn');
  });
  it('returns ok when pin matches latest cached version', () => {
    const { env } = setupFakeHomeWithCache({ pinned: '1.2.0', cached: ['1.0.0', '1.1.0', '1.2.0'] });
    const r = checkPluginPinCurrent(mkRoot(), env);
    expect(r.status).toBe('ok');
    expect(r.message).toContain('1.2.0');
  });
  it('returns warn when cache has newer version than pin', () => {
    const { env } = setupFakeHomeWithCache({ pinned: '1.0.0', cached: ['1.0.0', '1.2.0'] });
    const r = checkPluginPinCurrent(mkRoot(), env);
    expect(r.status).toBe('warn');
    expect(r.fix).toContain('install.sh');
    expect(r.fix).toContain('1.2.0');
  });
});

describe('checkStopHookFiredRecently', () => {
  it('returns ok when no goal active', () => {
    expect(checkStopHookFiredRecently(mkRoot()).status).toBe('ok');
  });
  it('returns ok when lifecycle != pursuing', () => {
    const root = mkRoot();
    saveTree(root, makeTree());
    saveState(root, makeState('sprint-1.epic-1.task-1', { lifecycle: 'paused', paused_at: new Date().toISOString() }));
    expect(checkStopHookFiredRecently(root).status).toBe('ok');
  });
  it('returns warn when state.json mtime is > 24h old', () => {
    const root = mkRoot();
    saveTree(root, makeTree());
    saveState(root, makeState());
    // Backdate state.json mtime by 48h
    const sp = statePath(root);
    const past = new Date(Date.now() - 48 * 3_600_000);
    fs.utimesSync(sp, past, past);
    const r = checkStopHookFiredRecently(root);
    expect(r.status).toBe('warn');
    expect(r.fix).toBeTruthy();
  });
});

describe('checkBudgetHeadroom', () => {
  it('returns ok when no goal active', () => {
    expect(checkBudgetHeadroom(mkRoot()).status).toBe('ok');
  });
  it('returns ok when budgets at 0%', () => {
    const root = mkRoot();
    saveTree(root, makeTree());
    saveState(root, makeState());
    expect(checkBudgetHeadroom(root).status).toBe('ok');
  });
  it('returns warn at 75% used', () => {
    const root = mkRoot();
    saveTree(root, makeTree());
    saveState(
      root,
      makeState('sprint-1.epic-1.task-1', {
        budget: {
          iterations: { used: 80, max: 100 },
          tokens: { used: 0, max: 1_000_000 },
          wallclock: { started_at: new Date().toISOString(), max_seconds: 86400 },
        },
      }),
    );
    const r = checkBudgetHeadroom(root);
    expect(r.status).toBe('warn');
  });
  it('returns fail at 95%+ used', () => {
    const root = mkRoot();
    saveTree(root, makeTree());
    saveState(
      root,
      makeState('sprint-1.epic-1.task-1', {
        budget: {
          iterations: { used: 96, max: 100 },
          tokens: { used: 0, max: 1_000_000 },
          wallclock: { started_at: new Date().toISOString(), max_seconds: 86400 },
        },
      }),
    );
    expect(checkBudgetHeadroom(root).status).toBe('fail');
  });
});

// runDoctor end-to-end ---------------------------------------------------

describe('runDoctor end-to-end', () => {
  it('returns a DoctorReport with all 8 checks present', () => {
    const root = mkRoot();
    saveTree(root, makeTree());
    saveState(root, makeState());
    const report = runDoctor(root, { HOME: mkRoot() });
    const ids = report.checks.map((c) => c.id).sort();
    expect(ids).toEqual(Object.keys(CHECKS).sort());
    expect(report.summary.ok + report.summary.warn + report.summary.fail).toBe(report.checks.length);
    expect([0, 1]).toContain(report.exitCode);
  });

  it('exitCode=1 when any check fails', () => {
    const root = mkRoot();
    saveTree(root, makeTree());
    saveState(root, makeState('sprint-9.epic-9.task-9')); // unresolvable cursor
    const report = runDoctor(root, { HOME: mkRoot() });
    expect(report.exitCode).toBe(1);
    expect(report.summary.fail).toBeGreaterThanOrEqual(1);
  });

  it('exitCode=0 on a clean fresh project (no goal)', () => {
    const root = mkRoot();
    const report = runDoctor(root, { HOME: mkRoot() });
    expect(report.exitCode).toBe(0);
  });

  it('per-check exception in a buggy check converts to fail entry without breaking the report', () => {
    // Inject a check that throws
    const orig = CHECKS['state-loadable'];
    CHECKS['state-loadable'] = () => {
      throw new Error('synthetic bug');
    };
    try {
      const report = runDoctor(mkRoot(), { HOME: mkRoot() });
      const stateCheck = report.checks.find((c) => c.id === 'state-loadable');
      expect(stateCheck.status).toBe('fail');
      expect(stateCheck.message).toContain('synthetic bug');
      // Other checks still ran
      expect(report.checks.length).toBe(Object.keys(CHECKS).length);
    } finally {
      CHECKS['state-loadable'] = orig;
    }
  });

  it('every check result conforms to DiagnosticCheckSchema', () => {
    const root = mkRoot();
    saveTree(root, makeTree());
    saveState(root, makeState());
    const report = runDoctor(root, { HOME: mkRoot() });
    for (const c of report.checks) {
      expect(() => DiagnosticCheckSchema.parse(c)).not.toThrow();
    }
  });
});
