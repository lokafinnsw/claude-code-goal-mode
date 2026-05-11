import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  EventLogEntrySchema,
  appendEvent,
  readEvents,
  tailEvents,
  eventsPath,
} from '../engine/event-log.mjs';
import { replayEvents } from '../engine/state-from-events.mjs';
import { activeDir } from '../engine/paths.mjs';

function mkRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'evlog-'));
}

function v2Tree() {
  return {
    schema_version: 2,
    goal_id: 'g',
    mission: 'm',
    created_at: new Date().toISOString(),
    approved_at: new Date().toISOString(),
    root: {
      id: 'sprint-1',
      type: 'sprint',
      title: 'S',
      goal: 'sg',
      acceptance_criteria: ['c'],
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
          title: 'E',
          goal: 'eg',
          acceptance_criteria: ['c'],
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
              title: 'T1',
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
            {
              id: 'sprint-1.epic-1.task-2',
              type: 'task',
              title: 'T2',
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

// Schema + helpers --------------------------------------------------------

describe('EventLogEntrySchema', () => {
  it('accepts a well-formed evidence-recorded event', () => {
    const e = {
      id: 'uuid',
      ts: new Date().toISOString(),
      iteration: 1,
      kind: 'evidence-recorded',
      payload: { node_id: 'x.t1', criterion: 0, note: 'done' },
      derived_from_tag: 'evidence',
    };
    expect(() => EventLogEntrySchema.parse(e)).not.toThrow();
  });
  it('rejects unknown event kind', () => {
    const e = {
      id: 'uuid',
      ts: new Date().toISOString(),
      iteration: 0,
      kind: 'not-a-real-kind',
      payload: {},
      derived_from_tag: null,
    };
    expect(() => EventLogEntrySchema.parse(e)).toThrow();
  });
});

// appendEvent + readEvents -----------------------------------------------

describe('appendEvent + readEvents', () => {
  it('readEvents returns [] for a project with no events.jsonl', () => {
    expect(readEvents(mkRoot())).toEqual([]);
  });

  it('appendEvent writes a single line and readEvents returns it', () => {
    const root = mkRoot();
    appendEvent(root, { kind: 'evidence-recorded', payload: { node_id: 'x' } });
    const all = readEvents(root);
    expect(all).toHaveLength(1);
    expect(all[0].kind).toBe('evidence-recorded');
    expect(all[0].id).toBeTruthy();
    expect(all[0].ts).toBeTruthy();
  });

  it('appendEvent auto-fills id, ts, derived_from_tag when omitted', () => {
    const root = mkRoot();
    appendEvent(root, { kind: 'cursor-advanced', payload: { node_id: 'x' } });
    const [e] = readEvents(root);
    expect(e.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(e.derived_from_tag).toBeNull();
  });

  it('appendEvent throws on invalid kind (does NOT write)', () => {
    const root = mkRoot();
    expect(() => appendEvent(root, { kind: 'invalid-kind' })).toThrow();
    expect(readEvents(root)).toEqual([]);
  });

  it('readEvents skips malformed lines but returns valid ones', () => {
    const root = mkRoot();
    const fp = eventsPath(root);
    fs.mkdirSync(activeDir(root), { recursive: true });
    fs.writeFileSync(
      fp,
      [
        JSON.stringify({ id: 'a', ts: new Date().toISOString(), iteration: 0, kind: 'cursor-advanced', payload: {}, derived_from_tag: null }),
        '{this is not valid json',
        JSON.stringify({ id: 'b', ts: new Date().toISOString(), iteration: 0, kind: 'cursor-advanced', payload: {}, derived_from_tag: null }),
      ].join('\n'),
    );
    // Suppress console.error noise from the malformed-line warning.
    const orig = console.error;
    console.error = () => {};
    try {
      const all = readEvents(root);
      expect(all).toHaveLength(2);
      expect(all[0].id).toBe('a');
      expect(all[1].id).toBe('b');
    } finally {
      console.error = orig;
    }
  });

  it('tailEvents returns last n events', () => {
    const root = mkRoot();
    for (let i = 0; i < 5; i++) {
      appendEvent(root, { kind: 'budget-tick', payload: { i }, iteration: i });
    }
    const tail = tailEvents(root, 2);
    expect(tail).toHaveLength(2);
    expect(tail[0].payload.i).toBe(3);
    expect(tail[1].payload.i).toBe(4);
  });
});

// replayEvents -----------------------------------------------------------

describe('replayEvents', () => {
  it('empty event log produces initial-shape state', () => {
    const tree = v2Tree();
    const { state, tree: outTree, applied } = replayEvents(tree, []);
    expect(applied).toBe(0);
    expect(state.cursor).toBe('sprint-1.epic-1.task-1'); // first pending
    expect(outTree.root.children[0].children[0].evidence).toEqual([]);
  });

  it('single evidence-recorded event populates task evidence array', () => {
    const tree = v2Tree();
    const events = [
      {
        id: 'e1',
        ts: new Date().toISOString(),
        iteration: 1,
        kind: 'evidence-recorded',
        payload: { node_id: 'sprint-1.epic-1.task-1', criterion: 0, file: 'src/x.ts', note: 'done' },
        derived_from_tag: 'evidence',
      },
    ];
    const { tree: out, applied } = replayEvents(tree, events);
    expect(applied).toBe(1);
    expect(out.root.children[0].children[0].evidence).toHaveLength(1);
    expect(out.root.children[0].children[0].evidence[0].note).toBe('done');
  });

  it('cursor-advanced event updates state.cursor and marks node achieved', () => {
    const tree = v2Tree();
    const events = [
      {
        id: 'e1',
        ts: new Date().toISOString(),
        iteration: 1,
        kind: 'cursor-advanced',
        payload: { node_id: 'sprint-1.epic-1.task-1' },
        derived_from_tag: null,
      },
    ];
    const { state, tree: out } = replayEvents(tree, events);
    expect(state.cursor).toBe('sprint-1.epic-1.task-2'); // next pending
    expect(out.root.children[0].children[0].status).toBe('achieved');
  });

  it('replay is deterministic — same events produce same state', () => {
    const tree = v2Tree();
    const events = [
      { id: 'e1', ts: new Date().toISOString(), iteration: 1, kind: 'evidence-recorded', payload: { node_id: 'sprint-1.epic-1.task-1', criterion: 0, note: 'a' }, derived_from_tag: 'evidence' },
      { id: 'e2', ts: new Date().toISOString(), iteration: 2, kind: 'cursor-advanced', payload: { node_id: 'sprint-1.epic-1.task-1' }, derived_from_tag: null },
    ];
    const a = replayEvents(tree, events);
    const b = replayEvents(tree, events);
    expect(a.state.cursor).toBe(b.state.cursor);
    expect(a.tree.root.children[0].children[0].status).toBe(
      b.tree.root.children[0].children[0].status,
    );
  });

  it('lifecycle-changed updates state.lifecycle', () => {
    const tree = v2Tree();
    const events = [
      { id: 'e1', ts: new Date().toISOString(), iteration: 1, kind: 'lifecycle-changed', payload: { to: 'achieved' }, derived_from_tag: null },
    ];
    const { state } = replayEvents(tree, events);
    expect(state.lifecycle).toBe('achieved');
    expect(state.ended_at).toBeTruthy();
  });

  it('blocker-set marks node blocked and increments review_attempts', () => {
    const tree = v2Tree();
    const events = [
      { id: 'e1', ts: new Date().toISOString(), iteration: 1, kind: 'blocker-set', payload: { node_id: 'sprint-1.epic-1.task-1', reason: 'broken' }, derived_from_tag: 'task-status' },
    ];
    const { tree: out } = replayEvents(tree, events);
    expect(out.root.children[0].children[0].status).toBe('blocked');
    expect(out.root.children[0].children[0].review_attempts).toBe(1);
    expect(out.root.children[0].children[0].blocker_reason).toBe('broken');
  });

  it('session-rebound updates state.session_id', () => {
    const tree = v2Tree();
    const events = [
      { id: 'e1', ts: new Date().toISOString(), iteration: 1, kind: 'session-rebound', payload: { old_session_id: 'a', new_session_id: 'b' }, derived_from_tag: null },
    ];
    const { state } = replayEvents(tree, events);
    expect(state.session_id).toBe('b');
  });

  it('verdict events are preserved as history entries even when not state-mutating', () => {
    const tree = v2Tree();
    const events = [
      { id: 'e1', ts: new Date().toISOString(), iteration: 1, kind: 'review-verdict-accepted', payload: { node_id: 'sprint-1.epic-1.task-1', agent: 'x', status: 'GO' }, derived_from_tag: 'audit-verdict' },
    ];
    const { state } = replayEvents(tree, events);
    expect(state.history.find((h) => h.event === 'review-verdict')).toBeTruthy();
  });
});
