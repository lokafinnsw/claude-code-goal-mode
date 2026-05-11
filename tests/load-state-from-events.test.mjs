/**
 * Tests for the snapshot-aware read path (Phase 5.1).
 *
 * `loadStateFromEvents` is the future canonical loadState (per ADR-0001
 * rc2 reader-switch). It composes snapshot + tail replay + reducer. These
 * tests prove the composition is correct end-to-end against real events.jsonl.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadStateFromEvents, saveState, saveTree } from '../engine/state.mjs';
import { appendEvent, appendTurnEvents } from '../engine/event-log.mjs';
import { writeSnapshot } from '../engine/snapshots.mjs';

function mkRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lsfe-'));
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

describe('loadStateFromEvents', () => {
  it('returns null when neither snapshot nor events.jsonl exists', async () => {
    expect(await loadStateFromEvents(mkRoot())).toBeNull();
  });

  it('replays from event log + seed tree when no snapshot exists', async () => {
    const root = mkRoot();
    saveTree(root, makeTree());
    appendEvent(root, {
      goal_id: 'g', kind: 'cursor-advanced',
      payload: {
        from: 'sprint-1.epic-1.task-1',
        to: 'sprint-1.epic-1.task-2',
        reason: 'achieved',
      },
    });
    const result = await loadStateFromEvents(root);
    expect(result).toBeTruthy();
    expect(result.state.cursor).toBe('sprint-1.epic-1.task-2');
  });

  it('uses snapshot + replays tail when snapshot exists', async () => {
    const root = mkRoot();
    const tree = makeTree();
    saveTree(root, tree);

    // Snapshot at seq=10 with cursor on task-1
    const snapState = { ...makeState(), cursor: 'sprint-1.epic-1.task-1' };
    writeSnapshot(root, 10, snapState, tree);

    // Append fresh event at seq=11
    appendEvent(root, {
      seq: 11, goal_id: 'g', kind: 'cursor-advanced',
      payload: {
        from: 'sprint-1.epic-1.task-1',
        to: 'sprint-1.epic-1.task-2',
        reason: 'achieved',
      },
    });
    const result = await loadStateFromEvents(root);
    expect(result.state.cursor).toBe('sprint-1.epic-1.task-2');
  });

  it('snapshot + empty tail returns snapshot state unchanged', async () => {
    const root = mkRoot();
    const tree = makeTree();
    saveTree(root, tree);
    const snapState = { ...makeState(), cursor: 'sprint-1.epic-1.task-2' };
    writeSnapshot(root, 100, snapState, tree);

    const result = await loadStateFromEvents(root);
    expect(result.state.cursor).toBe('sprint-1.epic-1.task-2');
  });

  it('handles transactional turn events as a single batch', async () => {
    const root = mkRoot();
    saveTree(root, makeTree());

    // Two events in one turn (same turn_id, consecutive seq).
    appendTurnEvents(root, 'turn-1', [
      { goal_id: 'g', kind: 'evidence-added',
        payload: { cursor: 'sprint-1.epic-1.task-1', criterion_index: 0, note: 'ev1' } },
      { goal_id: 'g', kind: 'cursor-advanced',
        payload: {
          from: 'sprint-1.epic-1.task-1',
          to: 'sprint-1.epic-1.task-2',
          reason: 'achieved',
        } },
    ]);
    const result = await loadStateFromEvents(root);
    expect(result.state.cursor).toBe('sprint-1.epic-1.task-2');
    expect(result.tree.root.children[0].evidence.length).toBe(1);
  });

  it('uses goal-created event tree_skeleton when no seed tree on disk', async () => {
    const root = mkRoot();
    const tree = makeTree();
    // No saveTree — only emit goal-created event carrying the skeleton.
    appendEvent(root, {
      goal_id: 'g', kind: 'goal-created',
      payload: {
        goal_id: 'g', mission: 'm',
        tree_skeleton: tree,
        created_at: '2026-05-11T10:00:00.000Z',
      },
    });
    const result = await loadStateFromEvents(root);
    expect(result).toBeTruthy();
    expect(result.tree.root.id).toBe('sprint-1');
    expect(result.state.lifecycle).toBe('draft');
  });
});
