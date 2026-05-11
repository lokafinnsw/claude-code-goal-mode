/**
 * v1.2.1 patch regression tests.
 *
 * Covers the ten items from the v1.2.0 self-critique that landed in 1.2.1:
 *   #1 replay completeness via goal-started + budget-tick
 *   #2 rejected verdicts surface in continuation-review
 *   #4 event-log + state.history rotation
 *   #5 pre-migration backup retention
 *   #6 semver dep correctness on pre-release tags
 *   #7 doctor --fix and runFix
 *   #8 goal-tree renderTree
 *   #9 install.sh end-to-end against tmp HOME
 *   #10 atomic write order: events first, state second
 */

import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';

import { runDoctor, runFix, CHECKS, FIXERS, checkPluginPinCurrent } from '../engine/doctor.mjs';
import { appendEvent, readEvents, eventsPath, maybeRotateEvents, ROTATE_THRESHOLD, ROTATE_KEEP } from '../engine/event-log.mjs';
import { replayEvents } from '../engine/state-from-events.mjs';
import { renderTree } from '../engine/goal-tree.mjs';
import { saveState, saveTree, loadState, loadTree } from '../engine/state.mjs';
import { activeDir, statePath, treePath, goalsDir } from '../engine/paths.mjs';
import { runStopHook } from '../engine/stop-hook.mjs';
import { startGoal } from '../engine/start-goal.mjs';

const REPO = path.resolve(new URL('..', import.meta.url).pathname);

// Shared fixtures --------------------------------------------------------

function mkRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'v121-'));
}

function makeTree() {
  return {
    schema_version: 2,
    goal_id: 'g',
    mission: 'm',
    created_at: new Date().toISOString(),
    approved_at: new Date().toISOString(),
    root: {
      id: 'sprint-1', type: 'sprint', title: 'Sprint', goal: 'sg',
      acceptance_criteria: ['c'], review: [], validate: null, work_front: null,
      status: 'pending', evidence: [], blocker_reason: null, review_attempts: 0, notes: [],
      children: [
        {
          id: 'sprint-1.epic-1', type: 'epic', title: 'Epic', goal: 'eg',
          acceptance_criteria: ['c'], review: [], validate: null, work_front: null,
          status: 'pending', evidence: [], blocker_reason: null, review_attempts: 0, notes: [],
          children: [
            { id: 'sprint-1.epic-1.task-1', type: 'task', title: 'T1', goal: 'tg',
              acceptance_criteria: ['ac0'], review: [], validate: null, work_front: null,
              status: 'pending', evidence: [], blocker_reason: null, review_attempts: 0, notes: [],
              children: [] },
            { id: 'sprint-1.epic-1.task-2', type: 'task', title: 'T2', goal: 'tg',
              acceptance_criteria: ['ac0'], review: [], validate: null, work_front: null,
              status: 'pending', evidence: [], blocker_reason: null, review_attempts: 0, notes: [],
              children: [] },
          ],
        },
      ],
    },
  };
}

function makeState(overrides = {}) {
  return {
    schema_version: 2, goal_id: 'g', lifecycle: 'pursuing',
    cursor: 'sprint-1.epic-1.task-1',
    budget: {
      iterations: { used: 0, max: 100 },
      tokens: { used: 0, max: 1_000_000 },
      wallclock: { started_at: new Date().toISOString(), max_seconds: 86400 },
    },
    session_id: 'sess-v121',
    started_at: new Date().toISOString(),
    paused_at: null, ended_at: null, ended_reason: null, history: [],
    ...overrides,
  };
}

// #1 — replay completeness ----------------------------------------------

describe('#1 replay completeness: goal-started + budget-tick events', () => {
  it('goal-started event seeds full initial state via replay', () => {
    const tree = makeTree();
    const events = [
      {
        id: 'e1', ts: '2026-05-11T10:00:00.000Z', iteration: 0,
        kind: 'goal-started',
        payload: {
          goal_id: 'g',
          session_id: 'real-uuid',
          cursor: 'sprint-1.epic-1.task-1',
          started_at: '2026-05-11T10:00:00.000Z',
          budget: {
            iterations: { used: 0, max: 200 },
            tokens: { used: 0, max: 5_000_000 },
            wallclock: { started_at: '2026-05-11T10:00:00.000Z', max_seconds: 14400 },
          },
        },
        derived_from_tag: null,
      },
    ];
    const { state } = replayEvents(tree, events);
    expect(state.session_id).toBe('real-uuid');
    expect(state.budget.iterations.max).toBe(200);
    expect(state.budget.tokens.max).toBe(5_000_000);
    expect(state.budget.wallclock.max_seconds).toBe(14400);
    expect(state.cursor).toBe('sprint-1.epic-1.task-1');
    expect(state.lifecycle).toBe('pursuing');
  });

  it('budget-tick events advance counters monotonically', () => {
    const tree = makeTree();
    const events = [
      { id: 'e1', ts: '2026-05-11T10:00:00.000Z', iteration: 0, kind: 'goal-started',
        payload: { budget: { iterations: { used: 0, max: 10 }, tokens: { used: 0, max: 1000 }, wallclock: { started_at: '2026-05-11T10:00:00.000Z', max_seconds: 100 } } },
        derived_from_tag: null },
      { id: 'e2', ts: '2026-05-11T10:01:00.000Z', iteration: 1, kind: 'budget-tick',
        payload: { iterations_used: 1, tokens_used: 100 }, derived_from_tag: null },
      { id: 'e3', ts: '2026-05-11T10:02:00.000Z', iteration: 2, kind: 'budget-tick',
        payload: { iterations_used: 2, tokens_used: 250 }, derived_from_tag: null },
    ];
    const { state } = replayEvents(tree, events);
    expect(state.budget.iterations.used).toBe(2);
    expect(state.budget.tokens.used).toBe(250);
  });

  it('startGoal emits goal-started event with full config', () => {
    const root = mkRoot();
    saveTree(root, makeTree());
    const result = startGoal(root, {
      sessionId: 'sess-start', maxIter: 50, tokenBudget: 2_000_000, timeBudgetSeconds: 7200,
    });
    expect(result.ok).toBe(true);
    const events = readEvents(root);
    const started = events.find((e) => e.kind === 'goal-started');
    expect(started).toBeTruthy();
    expect(started.payload.session_id).toBe('sess-start');
    expect(started.payload.budget.iterations.max).toBe(50);
    expect(started.payload.budget.tokens.max).toBe(2_000_000);
  });
});

// #2 — rejected verdict surfaces in continuation-review -----------------

describe('#2 rejected verdict visible in next continuation-review prompt', () => {
  it('stop-hook builds rejected_verdicts context for continuation-review', async () => {
    const root = mkRoot();
    const tree = makeTree();
    tree.root.children[0].children[0].review = ['art-x'];
    tree.root.children[0].children[0].status = 'review-pending';
    tree.root.children[0].children[0].evidence = [
      { ts: new Date().toISOString(), iteration: 0, criterion_index: 0, file: 'x', line: null, commit: null, command: null, exit_code: null, note: 'done' },
    ];
    saveTree(root, tree);
    // started_at well in the past so the rejected verdict (timestamped just
    // now) falls inside the filter window of "since last cursor-advanced
    // (or started_at if none)".
    saveState(root, makeState({
      cursor: 'sprint-1.epic-1.task-1',
      started_at: new Date(Date.now() - 600_000).toISOString(),
      history: [{
        ts: new Date().toISOString(),
        iteration: 1,
        event: 'review-verdict',
        node_id: 'sprint-1.epic-1.task-1',
        payload: { agent: 'art-x', status: 'GO', text: 'fabricated', rejected: true, reason: 'no Agent dispatch detected' },
      }],
    }));

    // Transcript without Agent dispatch — fresh GO will be rejected too.
    const tPath = path.join(root, 'tr.jsonl');
    fs.writeFileSync(tPath, JSON.stringify({
      timestamp: new Date().toISOString(),
      message: { role: 'assistant', content: [{ type: 'text', text: 'no tags' }] },
    }) + '\n');

    // Silence stderr from event-log diagnostics.
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = () => true;
    try {
      const result = await runStopHook({
        stdin: { session_id: 'sess-v121', transcript_path: tPath },
        projectRoot: root,
      });
      expect(result.stdout?.decision).toBe('block');
      // The continuation-review prompt must contain the rejected verdict block.
      expect(result.stdout.reason).toContain('Rejected verdicts');
      expect(result.stdout.reason).toContain('art-x');
      expect(result.stdout.reason).toContain('no Agent dispatch');
    } finally {
      process.stderr.write = origWrite;
    }
  });
});

// #4 — event log + history rotation -------------------------------------

describe('#4 event-log + state.history rotation', () => {
  it('maybeRotateEvents archives oldest half when threshold exceeded', () => {
    const root = mkRoot();
    fs.mkdirSync(activeDir(root), { recursive: true });
    // Hand-write more than ROTATE_THRESHOLD events to trigger rotation.
    const lines = [];
    for (let i = 0; i < ROTATE_THRESHOLD + 50; i++) {
      lines.push(JSON.stringify({
        id: `id-${i}`, ts: new Date(Date.now() + i).toISOString(), iteration: i,
        kind: 'budget-tick', payload: { i }, derived_from_tag: null,
      }));
    }
    fs.writeFileSync(eventsPath(root), lines.join('\n') + '\n');
    const rotated = maybeRotateEvents(root);
    expect(rotated).toBe(true);
    const active = readEvents(root);
    expect(active.length).toBe(ROTATE_KEEP);
    const archiveDir = path.join(goalsDir(root), 'archive');
    const archives = fs.readdirSync(archiveDir).filter((f) => f.startsWith('events-'));
    expect(archives.length).toBeGreaterThanOrEqual(1);
  });

  it('saveState rotates state.history when over 200 entries', () => {
    const root = mkRoot();
    saveTree(root, makeTree());
    const huge = makeState({
      history: Array.from({ length: 250 }, (_, i) => ({
        ts: new Date(Date.now() + i).toISOString(),
        iteration: i, event: 'cursor-advanced',
        node_id: 'sprint-1.epic-1.task-1', payload: { i },
      })),
    });
    saveState(root, huge);
    const loaded = loadState(root);
    expect(loaded.history.length).toBe(100);
    const archiveDir = path.join(root, '.claude', 'goals', 'archive');
    expect(fs.existsSync(archiveDir)).toBe(true);
    const archives = fs.readdirSync(archiveDir).filter((f) => f.startsWith('history-'));
    expect(archives.length).toBeGreaterThanOrEqual(1);
  });
});

// #5 — pre-migration backup retention ----------------------------------

describe('#5 pre-migration backup retention', () => {
  it('doctor reports retention warning when more than 3 backups exist', () => {
    const root = mkRoot();
    saveTree(root, makeTree());
    saveState(root, makeState());
    // Hand-fabricate 5 pre-migration backups.
    const dir = activeDir(root);
    for (let i = 0; i < 5; i++) {
      fs.writeFileSync(path.join(dir, `state.json.pre-migration-v1-${i}`), '{}');
    }
    const r = CHECKS['pre-migration-backup-retention'](root);
    expect(r.status).toBe('warn');
    expect(r.fix).toContain('--fix');
  });

  it('FIXERS["pre-migration-backup-retention"] keeps last 3, deletes older', () => {
    const root = mkRoot();
    saveTree(root, makeTree());
    saveState(root, makeState());
    const dir = activeDir(root);
    for (let i = 0; i < 5; i++) {
      const fp = path.join(dir, `state.json.pre-migration-v1-${i}`);
      fs.writeFileSync(fp, '{}');
      // Stagger mtimes so the "oldest" really is older.
      const base = Date.now() - (5 - i) * 1000;
      fs.utimesSync(fp, new Date(base), new Date(base));
    }
    const result = FIXERS['pre-migration-backup-retention'](root);
    expect(result.ran).toBe(true);
    const remaining = fs.readdirSync(dir).filter((f) => f.includes('.pre-migration-v'));
    expect(remaining.length).toBe(3);
  });
});

// #6 — semver pre-release handling -------------------------------------

describe('#6 semver dep correctness', () => {
  it('checkPluginPinCurrent treats 1.2.0-rc1 as older than 1.2.0', () => {
    const home = mkRoot();
    const installedDir = path.join(home, '.claude', 'plugins');
    fs.mkdirSync(installedDir, { recursive: true });
    fs.writeFileSync(path.join(installedDir, 'installed_plugins.json'), JSON.stringify({
      version: 2,
      plugins: {
        'goal-mode@goal-mode': [{
          scope: 'user',
          installPath: `${home}/.claude/plugins/cache/goal-mode/goal-mode/1.2.0`,
          version: '1.2.0',
          installedAt: new Date().toISOString(),
          lastUpdated: new Date().toISOString(),
        }],
      },
    }));
    const cacheDir = path.join(installedDir, 'cache', 'goal-mode', 'goal-mode');
    fs.mkdirSync(path.join(cacheDir, '1.2.0'), { recursive: true });
    fs.mkdirSync(path.join(cacheDir, '1.2.0-rc1'), { recursive: true });
    const r = checkPluginPinCurrent(mkRoot(), { HOME: home });
    // pinned 1.2.0 is newer than 1.2.0-rc1; doctor should report ok
    expect(r.status).toBe('ok');
  });
});

// #7 — doctor --fix integration ----------------------------------------

describe('#7 runFix orchestrator', () => {
  it('runFix returns one entry per fixer with ran/message', () => {
    const root = mkRoot();
    saveTree(root, makeTree());
    saveState(root, makeState());
    const applied = runFix(root);
    expect(applied.length).toBe(Object.keys(FIXERS).length);
    for (const a of applied) {
      expect(typeof a.id).toBe('string');
      expect(typeof a.ran).toBe('boolean');
      expect(typeof a.message).toBe('string');
    }
  });

  it('runFix deletes .broken-* and returns ran=true', () => {
    const root = mkRoot();
    saveTree(root, makeTree());
    saveState(root, makeState());
    const dir = activeDir(root);
    fs.writeFileSync(path.join(dir, 'state.json.broken-x-0'), '{}');
    const applied = runFix(root);
    const brokenFix = applied.find((a) => a.id === 'no-broken-backups');
    expect(brokenFix.ran).toBe(true);
    expect(fs.existsSync(path.join(dir, 'state.json.broken-x-0'))).toBe(false);
  });
});

// #8 — goal-tree renderTree ---------------------------------------------

describe('#8 renderTree', () => {
  it('renders sprint → epic → task with status glyphs', () => {
    const tree = makeTree();
    tree.root.children[0].children[0].status = 'achieved';
    const out = renderTree(tree, 'sprint-1.epic-1.task-2');
    expect(out).toContain('sprint-1');
    expect(out).toContain('sprint-1.epic-1');
    expect(out).toContain('sprint-1.epic-1.task-1');
    expect(out).toContain('sprint-1.epic-1.task-2');
    // Glyph for achieved
    expect(out).toContain('✓');
    // Cursor marker
    expect(out).toContain('CURSOR');
  });

  it('uses pursuing glyph for the cursor ancestor chain', () => {
    const tree = makeTree();
    const out = renderTree(tree, 'sprint-1.epic-1.task-1');
    // Cursor's task line should carry the pursuing glyph (since task.status is
    // 'pending', the glyph reflects status — task itself shows ·, but the
    // ancestor sprint/epic should show ▶ because cursor is inside).
    const lines = out.split('\n');
    const sprintLine = lines.find((l) => l.startsWith('sprint-1 '));
    expect(sprintLine).toMatch(/▶/);
  });

  it('handles empty children gracefully', () => {
    const tree = {
      schema_version: 2, goal_id: 'g', mission: 'm',
      created_at: new Date().toISOString(), approved_at: new Date().toISOString(),
      root: {
        id: 'sprint-1', type: 'sprint', title: 'Empty', goal: 'g',
        acceptance_criteria: ['c'], review: [], validate: null, work_front: null,
        status: 'pending', evidence: [], blocker_reason: null, review_attempts: 0, notes: [],
        children: [],
      },
    };
    const out = renderTree(tree, null);
    expect(out).toContain('sprint-1');
  });
});

// #10 — atomic write order: events first, state second -----------------

describe('#10 stop-hook writes events BEFORE state.json', () => {
  it('crash during state save still leaves events.jsonl with the latest budget-tick', async () => {
    const root = mkRoot();
    saveTree(root, makeTree());
    saveState(root, makeState());
    const tPath = path.join(root, 'tr.jsonl');
    fs.writeFileSync(tPath, JSON.stringify({
      timestamp: new Date().toISOString(),
      message: { role: 'assistant', content: [{ type: 'text', text: 'no tags' }] },
    }) + '\n');

    // Spy: saveState throws AFTER events are already written (event-first
    // contract). Run stop-hook; expect saved events present, state untouched.
    const stateModule = await import('../engine/state.mjs');
    const spy = vi.spyOn(stateModule, 'saveState').mockImplementation(() => {
      throw new Error('synthetic state save failure');
    });
    const origWrite = process.stderr.write.bind(process.stderr);
    const origErr = console.error;
    process.stderr.write = () => true;
    console.error = () => {};
    try {
      await runStopHook({
        stdin: { session_id: 'sess-v121', transcript_path: tPath },
        projectRoot: root,
      });
      const events = readEvents(root);
      const tick = events.find((e) => e.kind === 'budget-tick');
      expect(tick).toBeTruthy();
      expect(tick.payload.iterations_used).toBeGreaterThan(0);
    } finally {
      spy.mockRestore();
      process.stderr.write = origWrite;
      console.error = origErr;
    }
  });
});

// #9 — install.sh end-to-end against tmp HOME ---------------------------

describe('#9 install.sh runs end-to-end against an isolated tmp HOME', () => {
  it('deploys plugin cache, marketplace, settings, and installed_plugins pin', () => {
    const home = mkRoot();
    // Run install.sh with HOME overridden.
    const env = { ...process.env, HOME: home, PATH: process.env.PATH };
    let stdout = '';
    try {
      stdout = execSync(`bash "${REPO}/install.sh"`, { env, cwd: REPO, encoding: 'utf8' });
    } catch (err) {
      throw new Error(`install.sh failed: ${err.message}\n${err.stdout}\n${err.stderr}`);
    }
    expect(stdout).toContain('Plugin deployed to cache');
    expect(stdout).toContain('Pinned v');

    // Verify cache dir
    const cacheBase = path.join(home, '.claude', 'plugins', 'cache', 'goal-mode', 'goal-mode');
    expect(fs.existsSync(cacheBase)).toBe(true);
    const cachedVersions = fs.readdirSync(cacheBase);
    expect(cachedVersions.length).toBeGreaterThanOrEqual(1);
    // Each cached version has the engine and node_modules
    const v = cachedVersions[0];
    expect(fs.existsSync(path.join(cacheBase, v, 'engine', 'stop-hook.mjs'))).toBe(true);

    // Verify pin
    const installed = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'plugins', 'installed_plugins.json'), 'utf8'));
    const pin = installed.plugins['goal-mode@goal-mode'][0];
    expect(pin.version).toBe(v);
    expect(pin.installPath).toContain(v);

    // Verify settings.json enabled the plugin
    const settings = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
    expect(settings.enabledPlugins['goal-mode@goal-mode']).toBe(true);

    // Verify known_marketplaces.json has the entry
    const known = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'plugins', 'known_marketplaces.json'), 'utf8'));
    expect(known['goal-mode']).toBeTruthy();
  });

  it('install.sh is idempotent — re-run produces same end-state', () => {
    const home = mkRoot();
    const env = { ...process.env, HOME: home };
    execSync(`bash "${REPO}/install.sh"`, { env, cwd: REPO, encoding: 'utf8' });
    const beforePin = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'plugins', 'installed_plugins.json'), 'utf8'));
    execSync(`bash "${REPO}/install.sh"`, { env, cwd: REPO, encoding: 'utf8' });
    const afterPin = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'plugins', 'installed_plugins.json'), 'utf8'));
    expect(afterPin.plugins['goal-mode@goal-mode'][0].version).toBe(beforePin.plugins['goal-mode@goal-mode'][0].version);
    expect(afterPin.plugins['goal-mode@goal-mode'].length).toBe(1); // no duplicate entries
  });
});
