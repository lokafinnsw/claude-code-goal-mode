import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CURRENT_SCHEMA_VERSION,
  MigrationSchema,
  listMigrations,
  runMigrations,
} from '../engine/migrations.mjs';
import * as v1ToV2 from '../engine/migrations/v1-to-v2.mjs';
import { saveState, saveTree, loadState, loadTree } from '../engine/state.mjs';
import { activeDir, statePath, treePath } from '../engine/paths.mjs';

// Fixtures ---------------------------------------------------------------

function mkRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mig-'));
}

function v1State() {
  return {
    schema_version: 1,
    goal_id: 'g',
    lifecycle: 'pursuing',
    cursor: 'sprint-1.epic-1.task-1',
    budget: {
      iterations: { used: 0, max: 100 },
      tokens: { used: 0, max: 1_000_000 },
      wallclock: { started_at: new Date().toISOString(), max_seconds: 86400 },
    },
    session_id: 'sess-mig',
    started_at: new Date().toISOString(),
    paused_at: null,
    ended_at: null,
    ended_reason: null,
    history: [
      {
        ts: new Date().toISOString(),
        iteration: 0,
        event: 'started',
        node_id: 'sprint-1.epic-1.task-1',
        payload: {},
      },
    ],
  };
}

function v1Tree() {
  return {
    schema_version: 1,
    goal_id: 'g',
    mission: 'm',
    created_at: new Date().toISOString(),
    approved_at: new Date().toISOString(),
    root: {
      id: 'sprint-1',
      type: 'sprint',
      title: 's',
      goal: 'sg',
      acceptance_criteria: ['cond'],
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
          acceptance_criteria: ['cond'],
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
              id: 'sprint-1.epic-1.task-1',
              type: 'task',
              title: 't',
              goal: 'tg',
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
            },
          ],
        },
      ],
    },
  };
}

// Framework checks --------------------------------------------------------

describe('migration framework metadata', () => {
  it('CURRENT_SCHEMA_VERSION is the integer 2', () => {
    expect(CURRENT_SCHEMA_VERSION).toBe(2);
  });
  it('v1-to-v2 migration conforms to MigrationSchema', () => {
    expect(() => MigrationSchema.parse(v1ToV2)).not.toThrow();
    expect(v1ToV2.fromVersion).toBe(1);
    expect(v1ToV2.toVersion).toBe(2);
  });
});

describe('listMigrations', () => {
  it('returns empty chain when fromVersion === toVersion', () => {
    expect(listMigrations(2, 2)).toEqual([]);
    expect(listMigrations(1, 1)).toEqual([]);
  });
  it('throws on downgrade request', () => {
    expect(() => listMigrations(2, 1)).toThrow(/cannot downgrade/);
  });
  it('returns single-step chain v1 → v2', () => {
    const chain = listMigrations(1, 2);
    expect(chain).toHaveLength(1);
    expect(chain[0]).toBe(v1ToV2);
  });
  it('throws when no migration registered for fromVersion', () => {
    expect(() => listMigrations(99, 100)).toThrow(/no migration registered/);
  });
});

// runMigrations -----------------------------------------------------------

describe('runMigrations', () => {
  it('no-op same-version returns inputs untouched and applied=[]', () => {
    const s = v1State();
    s.schema_version = 2;
    const t = v1Tree();
    t.schema_version = 2;
    const r = runMigrations(s, t, 2, 2);
    expect(r.applied).toEqual([]);
    expect(r.error).toBeNull();
    expect(r.state).toBe(s);
    expect(r.tree).toBe(t);
  });

  it('v1 → v2 single-step migration produces schema_version=2 on both', () => {
    const r = runMigrations(v1State(), v1Tree(), 1, 2);
    expect(r.error).toBeNull();
    expect(r.applied).toEqual(['v1-to-v2']);
    expect(r.state.schema_version).toBe(2);
    expect(r.tree.schema_version).toBe(2);
  });

  it('migration does not mutate input objects', () => {
    const s = v1State();
    const t = v1Tree();
    const sBefore = JSON.parse(JSON.stringify(s));
    const tBefore = JSON.parse(JSON.stringify(t));
    runMigrations(s, t, 1, 2);
    expect(s).toEqual(sBefore);
    expect(t).toEqual(tBefore);
  });

  it('atomic rollback: a thrown migration step returns inputs untouched and applied=[]', () => {
    // Synthesize a migration that throws by overriding migrateState in a copy.
    const buggy = {
      fromVersion: 1,
      toVersion: 2,
      migrateState: () => { throw new Error('synthetic migration bug'); },
      migrateTree: (t) => ({ ...t, schema_version: 2 }),
    };
    // Inject by routing through runMigrations? It uses the registry, so
    // simulate by calling buggy directly — but to test runMigrations rollback,
    // we mock by temporarily patching the chain via listMigrations... easier:
    // we construct a minimal runner surrogate that mirrors runMigrations
    // semantics. But we want to test the REAL runMigrations, so:
    //
    // The registry is module-scope. We can't easily monkey-patch it without
    // dynamic mocking. Instead, validate the rollback contract by passing a
    // state shape that fails the schema_version invariant in v1-to-v2: we
    // poke schema_version to a non-1 value, which makes the invariant check
    // throw "did not bump schema_version" (since toVersion check fails).
    const s = { ...v1State(), schema_version: 1 };
    const t = { ...v1Tree(), schema_version: 1 };
    // Confirm no error in the happy path first.
    const happy = runMigrations(s, t, 1, 2);
    expect(happy.error).toBeNull();

    // Force failure: synthesize a state that v1-to-v2 cannot produce a v2
    // shape from — by removing the budget object. structuredClone in v1ToV2
    // will throw on undefined budget.
    const bad = { ...v1State(), budget: undefined };
    const r = runMigrations(bad, v1Tree(), 1, 2);
    expect(r.error).toBeTruthy();
    expect(r.applied).toEqual([]);
    expect(r.state).toBe(bad);
  });

  it('returns inputs unchanged when only state is provided (tree=null)', () => {
    const r = runMigrations(v1State(), null, 1, 2);
    expect(r.error).toBeNull();
    expect(r.state.schema_version).toBe(2);
    expect(r.tree).toBeNull();
  });
});

// v1-to-v2 specifics ------------------------------------------------------

describe('v1-to-v2 migration', () => {
  it('preserves history entries verbatim', () => {
    const s = v1State();
    s.history.push({
      ts: new Date().toISOString(),
      iteration: 1,
      event: 'cursor-advanced',
      node_id: 'sprint-1.epic-1.task-2',
      payload: { from: 'task-1' },
    });
    const out = v1ToV2.migrateState(s);
    expect(out.history).toHaveLength(s.history.length);
    expect(out.history[0]).toEqual(s.history[0]);
  });

  it('preserves all top-level state fields except schema_version', () => {
    const s = v1State();
    const out = v1ToV2.migrateState(s);
    for (const k of ['goal_id', 'lifecycle', 'cursor', 'session_id', 'started_at']) {
      expect(out[k]).toEqual(s[k]);
    }
    expect(out.schema_version).toBe(2);
  });

  it('migrateTree preserves node ids and structure', () => {
    const t = v1Tree();
    const out = v1ToV2.migrateTree(t);
    expect(out.schema_version).toBe(2);
    expect(out.root.id).toBe(t.root.id);
    expect(out.root.children[0].children[0].id).toBe('sprint-1.epic-1.task-1');
  });
});

// Auto-migrate on load ---------------------------------------------------

describe('readWithBackup auto-migration', () => {
  it('auto-migrates a v1 state.json on loadState and writes back v2 + .pre-migration backup', () => {
    const root = mkRoot();
    fs.mkdirSync(activeDir(root), { recursive: true });
    // Hand-write a v1 state (bypassing saveState's schema parse which now
    // expects v2). loadState should auto-migrate.
    fs.writeFileSync(statePath(root), JSON.stringify(v1State()));
    const loaded = loadState(root);
    expect(loaded).toBeTruthy();
    expect(loaded.schema_version).toBe(2);

    // Disk now has v2 form.
    const onDisk = JSON.parse(fs.readFileSync(statePath(root), 'utf8'));
    expect(onDisk.schema_version).toBe(2);

    // .pre-migration backup created.
    const files = fs.readdirSync(activeDir(root));
    expect(files.some((f) => f.includes('.pre-migration-v1-'))).toBe(true);
  });

  it('auto-migrates a v1 tree.json on loadTree', () => {
    const root = mkRoot();
    fs.mkdirSync(activeDir(root), { recursive: true });
    fs.writeFileSync(treePath(root), JSON.stringify(v1Tree()));
    const loaded = loadTree(root);
    expect(loaded).toBeTruthy();
    expect(loaded.schema_version).toBe(2);
    const onDisk = JSON.parse(fs.readFileSync(treePath(root), 'utf8'));
    expect(onDisk.schema_version).toBe(2);
  });

  it('v2 state.json (current) loads without re-migration or extra backups', () => {
    const root = mkRoot();
    saveState(root, { ...v1State(), schema_version: 2 });
    saveTree(root, { ...v1Tree(), schema_version: 2 });
    const before = fs.readdirSync(activeDir(root));
    const loaded = loadState(root);
    expect(loaded.schema_version).toBe(2);
    const after = fs.readdirSync(activeDir(root));
    expect(after).toEqual(before); // no new .pre-migration files
  });
});
