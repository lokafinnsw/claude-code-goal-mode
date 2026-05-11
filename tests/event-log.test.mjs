import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  EventLogEntrySchema,
  EVENT_KINDS,
  CURRENT_EVENT_SCHEMA_VERSION,
  appendEvent,
  appendTurnEvents,
  readEvents,
  tailEvents,
  countEvents,
  eventsPath,
} from '../engine/event-log.mjs';
import { EVENT_KIND_VALUES } from '../engine/event-payloads.mjs';
import { activeDir } from '../engine/paths.mjs';

function mkRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'evlog-spec-'));
}

const G = 'goal-test';

// ── Spec: 15 canonical kinds ──────────────────────────────────────────────

describe('event taxonomy', () => {
  it('exposes exactly 15 canonical kinds per ADR-0001', () => {
    expect(EVENT_KIND_VALUES).toHaveLength(15);
    expect(new Set(EVENT_KIND_VALUES).size).toBe(15);
  });
  it('EVENT_KINDS validates each canonical kind', () => {
    for (const k of EVENT_KIND_VALUES) {
      expect(EVENT_KINDS.safeParse(k).success).toBe(true);
    }
  });
  it('rejects unknown kinds', () => {
    expect(EVENT_KINDS.safeParse('made-up-kind').success).toBe(false);
  });
});

// ── EventLogEntrySchema ────────────────────────────────────────────────────

describe('EventLogEntrySchema', () => {
  it('accepts a well-formed event with all spec fields', () => {
    const e = {
      id: '01HXXX', ts: new Date().toISOString(), seq: 0, goal_id: G,
      schema_version: 1, kind: 'started', turn_id: null,
      payload: {
        session_id: 'sess-1',
        budget: {
          iterations: { used: 0, max: 100 },
          tokens: { used: 0, max: 1_000_000 },
          wallclock: { started_at: new Date().toISOString(), max_seconds: 86400 },
        },
        started_at: new Date().toISOString(),
        cursor: 'sprint-1.task-1',
      },
    };
    expect(() => EventLogEntrySchema.parse(e)).not.toThrow();
  });
  it('rejects missing goal_id', () => {
    expect(() => EventLogEntrySchema.parse({
      id: 'x', ts: new Date().toISOString(), seq: 0,
      schema_version: 1, kind: 'cursor-advanced', turn_id: null, payload: {},
    })).toThrow();
  });
  it('rejects negative seq', () => {
    expect(() => EventLogEntrySchema.parse({
      id: 'x', ts: new Date().toISOString(), seq: -1, goal_id: G,
      schema_version: 1, kind: 'cursor-advanced', turn_id: null, payload: {},
    })).toThrow();
  });
});

// ── appendEvent ────────────────────────────────────────────────────────────

describe('appendEvent', () => {
  it('writes a valid event and assigns monotonic seq', () => {
    const root = mkRoot();
    const a = appendEvent(root, {
      goal_id: G, kind: 'cursor-advanced',
      payload: { from: 'task-1', to: 'task-2', reason: 'achieved' },
    });
    const b = appendEvent(root, {
      goal_id: G, kind: 'cursor-advanced',
      payload: { from: 'task-2', to: 'task-3', reason: 'achieved' },
    });
    expect(a.seq).toBe(0);
    expect(b.seq).toBe(1);
    expect(a.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/); // ULID format
  });

  it('auto-fills id (ULID), ts, schema_version', () => {
    const root = mkRoot();
    const ev = appendEvent(root, {
      goal_id: G, kind: 'cursor-advanced',
      payload: { from: 'a', to: 'b', reason: 'achieved' },
    });
    expect(ev.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(ev.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(ev.schema_version).toBe(CURRENT_EVENT_SCHEMA_VERSION);
  });

  it('rejects missing goal_id at the appendEvent boundary', () => {
    const root = mkRoot();
    expect(() => appendEvent(root, { kind: 'cursor-advanced', payload: { from: 'a', to: 'b', reason: 'achieved' } })).toThrow(/goal_id/);
  });

  it('rejects invalid kind without writing', () => {
    const root = mkRoot();
    expect(() => appendEvent(root, { goal_id: G, kind: 'invalid', payload: {} })).toThrow();
    expect(readEvents(root)).toEqual([]);
  });

  it('rejects invalid payload shape for kind', () => {
    const root = mkRoot();
    expect(() => appendEvent(root, {
      goal_id: G, kind: 'cursor-advanced',
      payload: { from: 'a', to: 'b' /* missing reason */ },
    })).toThrow();
    expect(readEvents(root)).toEqual([]);
  });
});

// ── appendTurnEvents (transactional grouping) ──────────────────────────────

describe('appendTurnEvents', () => {
  it('writes multiple events with consecutive seq and shared turn_id', () => {
    const root = mkRoot();
    const turnId = 'turn-uuid-1';
    const result = appendTurnEvents(root, turnId, [
      { goal_id: G, kind: 'evidence-added', payload: { cursor: 't1', criterion_index: 0, note: 'ev1' } },
      { goal_id: G, kind: 'evidence-added', payload: { cursor: 't1', criterion_index: 1, note: 'ev2' } },
      { goal_id: G, kind: 'task-status-asserted', payload: { cursor: 't1', value: 'achieved' } },
      { goal_id: G, kind: 'cursor-advanced', payload: { from: 't1', to: 't2', reason: 'achieved' } },
    ]);
    expect(result).toHaveLength(4);
    expect(result.map((e) => e.seq)).toEqual([0, 1, 2, 3]);
    expect(new Set(result.map((e) => e.turn_id)).size).toBe(1);
    expect(result[0].turn_id).toBe(turnId);

    const onDisk = readEvents(root);
    expect(onDisk).toHaveLength(4);
    expect(onDisk[3].kind).toBe('cursor-advanced');
  });

  it('rejects the entire turn if any payload is invalid (atomicity)', () => {
    const root = mkRoot();
    expect(() => appendTurnEvents(root, 'turn-bad', [
      { goal_id: G, kind: 'cursor-advanced', payload: { from: 'a', to: 'b', reason: 'achieved' } },
      { goal_id: G, kind: 'cursor-advanced', payload: { /* missing required */ } },
    ])).toThrow();
    expect(readEvents(root)).toEqual([]);
  });

  it('empty partials array is a no-op', () => {
    const root = mkRoot();
    const result = appendTurnEvents(root, 't', []);
    expect(result).toEqual([]);
    expect(countEvents(root)).toBe(0);
  });
});

// ── readEvents ─────────────────────────────────────────────────────────────

describe('readEvents', () => {
  it('returns empty for missing events.jsonl', () => {
    expect(readEvents(mkRoot())).toEqual([]);
  });

  it('round-trips through disk preserving fields', () => {
    const root = mkRoot();
    appendEvent(root, {
      goal_id: G, kind: 'evidence-added',
      payload: { cursor: 't1', criterion_index: 0, note: 'roundtrip', file: 'src/x.ts' },
    });
    const events = readEvents(root);
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('evidence-added');
    expect(events[0].payload.note).toBe('roundtrip');
  });

  it('sorts by seq even if file has out-of-order lines', () => {
    const root = mkRoot();
    fs.mkdirSync(activeDir(root), { recursive: true });
    const lines = [
      JSON.stringify({ id: '2', ts: new Date().toISOString(), seq: 2, goal_id: G, schema_version: 1, kind: 'cursor-advanced', turn_id: null, payload: { from: 'b', to: 'c', reason: 'achieved' } }),
      JSON.stringify({ id: '0', ts: new Date().toISOString(), seq: 0, goal_id: G, schema_version: 1, kind: 'cursor-advanced', turn_id: null, payload: { from: 'a', to: 'b', reason: 'achieved' } }),
      JSON.stringify({ id: '1', ts: new Date().toISOString(), seq: 1, goal_id: G, schema_version: 1, kind: 'cursor-advanced', turn_id: null, payload: { from: 'a', to: 'b', reason: 'achieved' } }),
    ];
    fs.writeFileSync(eventsPath(root), lines.join('\n') + '\n');
    const events = readEvents(root);
    expect(events.map((e) => e.seq)).toEqual([0, 1, 2]);
  });

  it('skips malformed lines with stderr warning', () => {
    const root = mkRoot();
    fs.mkdirSync(activeDir(root), { recursive: true });
    fs.writeFileSync(eventsPath(root), [
      JSON.stringify({ id: 'a', ts: new Date().toISOString(), seq: 0, goal_id: G, schema_version: 1, kind: 'cursor-advanced', turn_id: null, payload: { from: 'a', to: 'b', reason: 'achieved' } }),
      '{this is not json',
      JSON.stringify({ id: 'b', ts: new Date().toISOString(), seq: 1, goal_id: G, schema_version: 1, kind: 'cursor-advanced', turn_id: null, payload: { from: 'b', to: 'c', reason: 'achieved' } }),
    ].join('\n'));
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = () => true;
    try {
      const events = readEvents(root);
      expect(events).toHaveLength(2);
    } finally {
      process.stderr.write = orig;
    }
  });

  it('skips v1.2.x rows by default (no seq field)', () => {
    const root = mkRoot();
    fs.mkdirSync(activeDir(root), { recursive: true });
    fs.writeFileSync(eventsPath(root), [
      // v1.2.x legacy row (UUID id, derived_from_tag, no seq)
      JSON.stringify({ id: 'uuid-1234', ts: new Date().toISOString(), iteration: 1, kind: 'evidence-recorded', payload: { node_id: 't1', note: 'legacy' }, derived_from_tag: 'evidence' }),
      // v2 row
      JSON.stringify({ id: 'ulid-1', ts: new Date().toISOString(), seq: 0, goal_id: G, schema_version: 1, kind: 'cursor-advanced', turn_id: null, payload: { from: 'a', to: 'b', reason: 'achieved' } }),
    ].join('\n'));
    const events = readEvents(root);
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('cursor-advanced');
  });

  it('migrates v1.2.x rows when { migrate: true }', () => {
    const root = mkRoot();
    fs.mkdirSync(activeDir(root), { recursive: true });
    fs.writeFileSync(eventsPath(root), [
      JSON.stringify({ id: 'uuid-1234', ts: new Date().toISOString(), kind: 'evidence-recorded', payload: { node_id: 't1', note: 'legacy' } }),
      JSON.stringify({ id: 'uuid-5678', ts: new Date().toISOString(), kind: 'goal-started', payload: { goal_id: G } }),
      JSON.stringify({ id: 'uuid-9012', ts: new Date().toISOString(), kind: 'budget-tick', payload: {} }),
    ].join('\n'));
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = () => true;
    try {
      const events = readEvents(root, { migrate: true });
      const kinds = events.map((e) => e.kind);
      expect(kinds).toContain('evidence-added'); // remapped from evidence-recorded
      expect(kinds).toContain('started');         // remapped from goal-started
      expect(kinds).toContain('budget-tally');    // remapped from budget-tick
    } finally {
      process.stderr.write = orig;
    }
  });
});

// ── tailEvents + countEvents ───────────────────────────────────────────────

describe('tailEvents + countEvents', () => {
  it('tailEvents returns last n', () => {
    const root = mkRoot();
    for (let i = 0; i < 5; i++) {
      appendEvent(root, {
        goal_id: G, kind: 'cursor-advanced',
        payload: { from: `t${i}`, to: `t${i + 1}`, reason: 'achieved' },
      });
    }
    const tail = tailEvents(root, 2);
    expect(tail).toHaveLength(2);
    expect(tail[0].seq).toBe(3);
    expect(tail[1].seq).toBe(4);
  });

  it('countEvents returns line count without full validation', () => {
    const root = mkRoot();
    expect(countEvents(root)).toBe(0);
    appendEvent(root, {
      goal_id: G, kind: 'cursor-advanced',
      payload: { from: 'a', to: 'b', reason: 'achieved' },
    });
    expect(countEvents(root)).toBe(1);
  });
});
