/**
 * Replay performance benchmark — acceptance gates G1.3 (cold) + G1.4 (warm)
 * per ADR-0001 §Acceptance gates.
 *
 * SLOs:
 *   - G1.3 cold: reduce 10,000 events from genesis < 500ms (p50), < 2000ms (p99)
 *   - G1.4 warm: snapshot at seq=9000 + tail replay (1000 events) < 100ms (p50)
 *
 * Hardware tier: M1 / 8GB. CI on slower runners may need scaled thresholds.
 * The current implementation hits these SLOs by an order of magnitude on
 * a development M-series Mac, so even 4× slower CI should still pass.
 *
 * Test strategy:
 *   - 5 runs per benchmark; report median + p99
 *   - Synthesise realistic event mix (budget-tally + evidence-added +
 *     cursor-advanced; the kinds Stop hook emits most often)
 *   - Fail the test if median exceeds the SLO; warn if p99 exceeds
 */

import { describe, it, expect } from 'vitest';
import { reduce } from '../engine/reducer.mjs';
import { performance } from 'node:perf_hooks';

function makeSkeleton(taskCount = 100) {
  const tasks = [];
  for (let i = 0; i < taskCount; i++) {
    tasks.push({
      id: `sprint-1.epic-1.task-${i}`,
      type: 'task',
      title: `T${i}`,
      goal: `goal ${i}`,
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
    });
  }
  return {
    schema_version: 2, goal_id: 'bench', mission: 'benchmark',
    created_at: '2026-05-11T10:00:00.000Z',
    approved_at: '2026-05-11T10:00:00.000Z',
    root: {
      id: 'sprint-1', type: 'sprint', title: 'S', goal: 'sg',
      acceptance_criteria: ['c'], review: [], validate: null, work_front: null,
      status: 'pending', evidence: [], blocker_reason: null, review_attempts: 0, notes: [],
      children: [{
        id: 'sprint-1.epic-1', type: 'epic', title: 'E', goal: 'eg',
        acceptance_criteria: ['c'], review: [], validate: null, work_front: null,
        status: 'pending', evidence: [], blocker_reason: null, review_attempts: 0, notes: [],
        children: tasks,
      }],
    },
  };
}

function generateEvents(N, taskCount = 100) {
  const events = [];
  // 1 started event up front
  events.push({
    id: 'evt-0', ts: new Date(2026, 4, 11, 10, 0, 0).toISOString(),
    seq: 0, goal_id: 'bench', schema_version: 1,
    kind: 'started', turn_id: null,
    payload: {
      session_id: 'sess-bench',
      cursor: `sprint-1.epic-1.task-0`,
      started_at: new Date(2026, 4, 11, 10, 0, 0).toISOString(),
      budget: {
        iterations: { used: 0, max: 10_000 },
        tokens: { used: 0, max: 1_000_000_000 },
        wallclock: { started_at: new Date(2026, 4, 11, 10, 0, 0).toISOString(), max_seconds: 0 },
      },
    },
  });
  // Realistic mix: 60% budget-tally, 30% evidence-added, 10% cursor-advanced
  for (let i = 1; i < N; i++) {
    const taskIdx = Math.floor(i / 10) % taskCount;
    const cursor = `sprint-1.epic-1.task-${taskIdx}`;
    const roll = i % 10;
    let payload, kind;
    if (roll < 6) {
      kind = 'budget-tally';
      payload = {
        iterations: { used: Math.floor(i / 10), max: 10_000 },
        tokens: { used: i * 100, max: 1_000_000_000 },
        wallclock: { elapsed_seconds: i, max_seconds: 0 },
      };
    } else if (roll < 9) {
      kind = 'evidence-added';
      payload = { cursor, criterion_index: 0, note: `evidence ${i}` };
    } else {
      kind = 'cursor-advanced';
      const nextIdx = (taskIdx + 1) % taskCount;
      payload = {
        from: cursor,
        to: `sprint-1.epic-1.task-${nextIdx}`,
        reason: 'achieved',
      };
    }
    events.push({
      id: `evt-${i}`,
      ts: new Date(2026, 4, 11, 10, 0, i).toISOString(),
      seq: i,
      goal_id: 'bench',
      schema_version: 1,
      kind,
      turn_id: null,
      payload,
    });
  }
  return events;
}

function timeReduce(initialTree, events, initialState = null) {
  const t0 = performance.now();
  const r = reduce(initialTree, events, initialState);
  const t1 = performance.now();
  return { ms: t1 - t0, result: r };
}

function median(arr) {
  const sorted = [...arr].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function p99(arr) {
  const sorted = [...arr].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length * 0.99)] ?? sorted[sorted.length - 1];
}

// ── G1.3 — Cold replay (genesis → 10k events) ───────────────────────────

describe('G1.3 acceptance gate — cold replay 10k events from genesis', () => {
  it('p50 < 500ms, p99 < 2000ms on M1 hardware tier (4× headroom for slower CI)', () => {
    const N = 10_000;
    const TASK_COUNT = 100;
    const tree = makeSkeleton(TASK_COUNT);
    const events = generateEvents(N, TASK_COUNT);

    // Warm-up run (JIT compilation)
    timeReduce(tree, events);

    const measurements = [];
    for (let i = 0; i < 5; i++) {
      measurements.push(timeReduce(tree, events).ms);
    }
    const med = median(measurements);
    const tail = p99(measurements);

    process.stderr.write(
      `[bench] G1.3 cold replay 10k events: p50=${med.toFixed(1)}ms p99=${tail.toFixed(1)}ms (runs: ${measurements.map((m) => m.toFixed(1)).join(', ')})\n`,
    );

    expect(med).toBeLessThan(500);
    expect(tail).toBeLessThan(2000);
  }, 60_000);
});

// ── G1.4 — Warm replay (snapshot + 1k tail) ─────────────────────────────

describe('G1.4 acceptance gate — warm replay snapshot+tail', () => {
  it('p50 < 100ms, p99 < 200ms (snapshot at seq=9000, tail=1000 events)', () => {
    const N = 10_000;
    const TASK_COUNT = 100;
    const tree = makeSkeleton(TASK_COUNT);
    const allEvents = generateEvents(N, TASK_COUNT);
    // Pre-compute the snapshot at seq=9000
    const cold = reduce(tree, allEvents.slice(0, 9000));
    const snapshotState = cold.state;
    const snapshotTree = cold.tree;
    const tail = allEvents.slice(9000); // 1000 events

    // Warm-up
    timeReduce(snapshotTree, tail, snapshotState);

    const measurements = [];
    for (let i = 0; i < 5; i++) {
      measurements.push(timeReduce(snapshotTree, tail, snapshotState).ms);
    }
    const med = median(measurements);
    const tailP99 = p99(measurements);

    process.stderr.write(
      `[bench] G1.4 warm replay (snap@9000 + 1k tail): p50=${med.toFixed(1)}ms p99=${tailP99.toFixed(1)}ms (runs: ${measurements.map((m) => m.toFixed(1)).join(', ')})\n`,
    );

    expect(med).toBeLessThan(100);
    expect(tailP99).toBeLessThan(200);
  }, 60_000);
});

// ── Scaling — smaller inputs for sanity ────────────────────────────────

describe('replay scaling sanity', () => {
  it('100 events reduces in < 10ms', () => {
    const tree = makeSkeleton(10);
    const events = generateEvents(100, 10);
    timeReduce(tree, events); // warm
    const ms = timeReduce(tree, events).ms;
    expect(ms).toBeLessThan(10);
  });
  it('1k events reduces in < 50ms', () => {
    const tree = makeSkeleton(50);
    const events = generateEvents(1000, 50);
    timeReduce(tree, events); // warm
    const ms = timeReduce(tree, events).ms;
    expect(ms).toBeLessThan(50);
  });
});
