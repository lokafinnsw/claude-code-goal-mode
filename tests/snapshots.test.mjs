import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ulid } from 'ulid';
import {
  SNAPSHOT_INTERVAL,
  SNAPSHOT_KEEP,
  snapshotsDir,
  writeSnapshot,
  findLatestSnapshot,
  listSnapshots,
  replayFromSnapshot,
  gcSnapshots,
  shouldSnapshot,
  snapshotAndGc,
  SnapshotSchema,
} from '../engine/snapshots.mjs';
import { appendEvent } from '../engine/event-log.mjs';
import { activeDir, eventsPath } from '../engine/paths.mjs';

function mkRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'snap-'));
}

function makeTree() {
  return {
    schema_version: 2, goal_id: 'g', mission: 'm',
    created_at: '2026-05-11T10:00:00.000Z', approved_at: '2026-05-11T11:00:00.000Z',
    root: {
      id: 'sprint-1', type: 'sprint', title: 'S', goal: 'sg',
      acceptance_criteria: ['c'], review: [], validate: null, work_front: null,
      status: 'pending', evidence: [], blocker_reason: null, review_attempts: 0, notes: [],
      children: [
        { id: 'sprint-1.epic-1.task-1', type: 'task', title: 'T1', goal: 'tg',
          acceptance_criteria: ['ac0'], review: [], validate: null, work_front: null,
          status: 'pending', evidence: [], blocker_reason: null, review_attempts: 0, notes: [], children: [] },
        { id: 'sprint-1.epic-1.task-2', type: 'task', title: 'T2', goal: 'tg',
          acceptance_criteria: ['ac0'], review: [], validate: null, work_front: null,
          status: 'pending', evidence: [], blocker_reason: null, review_attempts: 0, notes: [], children: [] },
      ],
    },
  };
}

function makeState() {
  return {
    schema_version: 2, goal_id: 'g', lifecycle: 'pursuing',
    cursor: 'sprint-1.epic-1.task-1',
    budget: {
      iterations: { used: 0, max: 100 },
      tokens: { used: 0, max: 1_000_000 },
      wallclock: { started_at: '2026-05-11T11:00:00.000Z', max_seconds: 86400 },
    },
    session_id: 's',
    started_at: '2026-05-11T11:00:00.000Z',
    paused_at: null, ended_at: null, ended_reason: null, history: [],
  };
}

// ── SnapshotSchema ────────────────────────────────────────────────────────

describe('SnapshotSchema', () => {
  it('accepts a well-formed snapshot', () => {
    const s = {
      schema_version: 1, seq: 0,
      taken_at: new Date().toISOString(),
      state: makeState(), tree: makeTree(),
    };
    expect(() => SnapshotSchema.parse(s)).not.toThrow();
  });
  it('rejects negative seq', () => {
    const s = { schema_version: 1, seq: -1, taken_at: new Date().toISOString(), state: {}, tree: {} };
    expect(() => SnapshotSchema.parse(s)).toThrow();
  });
});

// ── writeSnapshot + findLatestSnapshot ────────────────────────────────────

describe('writeSnapshot + findLatestSnapshot', () => {
  it('writes a snapshot and finds it back', () => {
    const root = mkRoot();
    const tree = makeTree();
    const state = makeState();
    writeSnapshot(root, 42, state, tree);
    const found = findLatestSnapshot(root);
    expect(found).toBeTruthy();
    expect(found.seq).toBe(42);
    expect(found.snapshot.state.cursor).toBe(state.cursor);
    expect(found.snapshot.tree.root.id).toBe(tree.root.id);
  });

  it('returns null when no snapshots exist', () => {
    expect(findLatestSnapshot(mkRoot())).toBeNull();
  });

  it('latest is highest seq even when older snapshots present', () => {
    const root = mkRoot();
    writeSnapshot(root, 5, makeState(), makeTree());
    writeSnapshot(root, 100, makeState(), makeTree());
    writeSnapshot(root, 42, makeState(), makeTree());
    expect(findLatestSnapshot(root).seq).toBe(100);
  });

  it('filename uses zero-padded seq (lexicographic sort = numeric sort)', () => {
    const root = mkRoot();
    writeSnapshot(root, 5, makeState(), makeTree());
    writeSnapshot(root, 100, makeState(), makeTree());
    const dir = snapshotsDir(root);
    const files = fs.readdirSync(dir).sort(); // lexicographic
    expect(files[0]).toContain('0000000005');
    expect(files[1]).toContain('0000000100');
  });

  it('atomic write: temp file does not linger', () => {
    const root = mkRoot();
    writeSnapshot(root, 1, makeState(), makeTree());
    const dir = snapshotsDir(root);
    const files = fs.readdirSync(dir);
    expect(files.every((f) => !f.endsWith('.tmp'))).toBe(true);
  });

  it('returns null when snapshot file is corrupt', () => {
    const root = mkRoot();
    const dir = snapshotsDir(root);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'snap-0000000001.json'), '{not json');
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = () => true;
    try {
      expect(findLatestSnapshot(root)).toBeNull();
    } finally {
      process.stderr.write = origWrite;
    }
  });
});

// ── listSnapshots ─────────────────────────────────────────────────────────

describe('listSnapshots', () => {
  it('returns empty when no snapshots dir', () => {
    expect(listSnapshots(mkRoot())).toEqual([]);
  });
  it('returns all in descending seq order', () => {
    const root = mkRoot();
    writeSnapshot(root, 1, makeState(), makeTree());
    writeSnapshot(root, 5, makeState(), makeTree());
    writeSnapshot(root, 3, makeState(), makeTree());
    const all = listSnapshots(root);
    expect(all.map((e) => e.seq)).toEqual([5, 3, 1]);
  });
});

// ── replayFromSnapshot ────────────────────────────────────────────────────

describe('replayFromSnapshot', () => {
  it('returns null when no snapshot AND no initial tree', () => {
    expect(replayFromSnapshot(mkRoot())).toBeNull();
  });

  it('replays from genesis when no snapshot but initial tree provided', () => {
    const root = mkRoot();
    appendEvent(root, {
      goal_id: 'g', kind: 'cursor-advanced',
      payload: { from: 'sprint-1.epic-1.task-1', to: 'sprint-1.epic-1.task-2', reason: 'achieved' },
    });
    const r = replayFromSnapshot(root, makeTree());
    expect(r.state.cursor).toBe('sprint-1.epic-1.task-2');
  });

  it('uses snapshot + replays tail events newer than snapshot.seq', () => {
    const root = mkRoot();
    const tree = makeTree();
    // Snapshot at seq=10 with cursor on task-1
    const snapState = { ...makeState(), cursor: 'sprint-1.epic-1.task-1' };
    writeSnapshot(root, 10, snapState, tree);
    // Now append a fresh event at seq=11 that moves cursor
    appendEvent(root, {
      seq: 11, goal_id: 'g', kind: 'cursor-advanced',
      payload: { from: 'sprint-1.epic-1.task-1', to: 'sprint-1.epic-1.task-2', reason: 'achieved' },
    });
    const r = replayFromSnapshot(root);
    expect(r.state.cursor).toBe('sprint-1.epic-1.task-2');
  });

  it('ignores events with seq <= snapshot.seq (they are already baked into snapshot state)', () => {
    const root = mkRoot();
    // First emit an event at seq=0
    appendEvent(root, {
      seq: 0, goal_id: 'g', kind: 'cursor-advanced',
      payload: { from: 'a', to: 'b', reason: 'achieved' },
    });
    // Then write a snapshot at seq=0 with state already reflecting it
    writeSnapshot(root, 0, { ...makeState(), cursor: 'b' }, makeTree());
    // Re-replay shouldn't double-apply the event
    const r = replayFromSnapshot(root);
    expect(r.state.cursor).toBe('b');
  });
});

// ── gcSnapshots ───────────────────────────────────────────────────────────

describe('gcSnapshots', () => {
  it('returns 0 when no snapshots exist', () => {
    expect(gcSnapshots(mkRoot())).toBe(0);
  });

  it('keeps the most recent N, deletes older', () => {
    const root = mkRoot();
    for (let i = 1; i <= 10; i++) writeSnapshot(root, i, makeState(), makeTree());
    const removed = gcSnapshots(root, { keep: 3 });
    expect(removed).toBe(7);
    const remaining = listSnapshots(root);
    expect(remaining).toHaveLength(3);
    expect(remaining.map((e) => e.seq)).toEqual([10, 9, 8]);
  });

  it('default keep is SNAPSHOT_KEEP=5', () => {
    const root = mkRoot();
    for (let i = 1; i <= 8; i++) writeSnapshot(root, i, makeState(), makeTree());
    expect(gcSnapshots(root)).toBe(3);
    expect(listSnapshots(root)).toHaveLength(5);
  });
});

// ── shouldSnapshot policy ─────────────────────────────────────────────────

describe('shouldSnapshot policy', () => {
  it('returns true on cursor-advanced event', () => {
    expect(shouldSnapshot(
      [{ kind: 'cursor-advanced' }, { kind: 'budget-tally' }],
      0, 1,
    )).toBe(true);
  });

  it('returns true on cleared event', () => {
    expect(shouldSnapshot([{ kind: 'cleared' }], 0, 1)).toBe(true);
  });

  it('returns false on routine events (budget-tally, evidence-added)', () => {
    expect(shouldSnapshot(
      [{ kind: 'budget-tally' }, { kind: 'evidence-added' }],
      0, 1,
    )).toBe(false);
  });

  it('returns true when seq crosses SNAPSHOT_INTERVAL boundary', () => {
    expect(shouldSnapshot([{ kind: 'budget-tally' }], 49, 50)).toBe(true);
    expect(shouldSnapshot([{ kind: 'budget-tally' }], 99, 100)).toBe(true);
  });

  it('returns false when seq does not cross boundary', () => {
    expect(shouldSnapshot([{ kind: 'budget-tally' }], 51, 52)).toBe(false);
  });
});

// ── snapshotAndGc end-to-end ──────────────────────────────────────────────

describe('snapshotAndGc', () => {
  it('writes snapshot and gc-cycles in one call', () => {
    const root = mkRoot();
    for (let i = 1; i <= 6; i++) writeSnapshot(root, i, makeState(), makeTree());
    const result = snapshotAndGc(root, 7, makeState(), makeTree(), { keep: 3 });
    expect(result.written).toBeTruthy();
    expect(result.removed).toBeGreaterThanOrEqual(3);
    const remaining = listSnapshots(root);
    expect(remaining).toHaveLength(3);
    expect(remaining[0].seq).toBe(7); // newest
  });
});

// ── Constants ─────────────────────────────────────────────────────────────

describe('snapshot constants', () => {
  it('SNAPSHOT_INTERVAL is 50 per ADR-0001', () => {
    expect(SNAPSHOT_INTERVAL).toBe(50);
  });
  it('SNAPSHOT_KEEP is 5', () => {
    expect(SNAPSHOT_KEEP).toBe(5);
  });
});
