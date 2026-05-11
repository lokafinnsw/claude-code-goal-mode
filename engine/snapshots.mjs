/**
 * Snapshot management — periodic full-state checkpoints of the event log.
 *
 * Per ADR-0001 §Read modes:
 *   - **Hot read**: snapshot + tail replay. Snapshot loaded as JSON; tail
 *     replayed via reducer. O(tail_length) per load, not O(total_events).
 *   - **Cold read**: replay from event 0. Used by forensic / replay tools.
 *
 * Trigger policy (when to write a snapshot):
 *   - Every `cursor-advanced` event (natural milestones, ~10-100×/goal)
 *   - Every `SNAPSHOT_INTERVAL` events (safety net for long-running goals
 *     that don't advance cursor often, e.g., a stuck review loop)
 *   - On `cleared` lifecycle event (final snapshot for archive)
 *
 * Retention:
 *   - Keep last `SNAPSHOT_KEEP` snapshots, gc older
 *   - Default policy: 5 retained
 *
 * File layout:
 *   .claude/goals/active/snapshots/
 *   ├── snap-0000000000.json         # genesis (rare; only for migration)
 *   ├── snap-0000000042.json         # state after event seq=42
 *   ├── snap-0000000100.json
 *   └── snap-0000000150.json         # latest
 *
 * The numeric portion is `seq` zero-padded to 10 digits — lexicographic
 * sort matches numeric sort, so `fs.readdirSync().sort()` yields a usable
 * order without parsing.
 */

import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { activeDir } from './paths.mjs';
import { reduce } from './reducer.mjs';
import { readEvents } from './event-log.mjs';

export const SNAPSHOT_INTERVAL = 50;
export const SNAPSHOT_KEEP = 5;

const SNAPSHOTS_DIR = 'snapshots';
const SEQ_PAD = 10;

export const SnapshotSchema = z.object({
  schema_version: z.literal(1),
  seq: z.number().int().nonnegative(),
  taken_at: z.string().datetime(),
  state: z.record(z.string(), z.unknown()),
  tree: z.record(z.string(), z.unknown()),
});

export function snapshotsDir(projectRoot) {
  return path.join(activeDir(projectRoot), SNAPSHOTS_DIR);
}

function snapshotPath(projectRoot, seq) {
  const padded = String(seq).padStart(SEQ_PAD, '0');
  return path.join(snapshotsDir(projectRoot), `snap-${padded}.json`);
}

function parseSnapshotSeq(filename) {
  const m = /^snap-(\d+)\.json$/.exec(filename);
  return m ? Number(m[1]) : null;
}

/**
 * Write a snapshot to disk. Atomic via temp+rename.
 *
 * @param projectRoot directory containing .claude/goals/active
 * @param seq the event-log seq this snapshot captures state AS-OF
 * @param state the GoalState at that seq
 * @param tree the GoalTree at that seq
 * @returns the absolute path of the written file
 */
export function writeSnapshot(projectRoot, seq, state, tree) {
  const dir = snapshotsDir(projectRoot);
  fs.mkdirSync(dir, { recursive: true });
  const snapshot = {
    schema_version: 1,
    seq,
    taken_at: new Date().toISOString(),
    state,
    tree,
  };
  SnapshotSchema.parse(snapshot);
  const finalPath = snapshotPath(projectRoot, seq);
  const tmpPath = finalPath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(snapshot, null, 2));
  fs.renameSync(tmpPath, finalPath);
  return finalPath;
}

/**
 * Find the latest snapshot by seq (lexicographic = numeric due to padding).
 * Returns null when no snapshots exist.
 */
export function findLatestSnapshot(projectRoot) {
  const dir = snapshotsDir(projectRoot);
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return null;
  }
  const seqs = entries
    .map(parseSnapshotSeq)
    .filter((n) => n !== null)
    .sort((a, b) => b - a); // descending
  if (seqs.length === 0) return null;
  const latestSeq = seqs[0];
  const fp = snapshotPath(projectRoot, latestSeq);
  try {
    const raw = fs.readFileSync(fp, 'utf8');
    const parsed = JSON.parse(raw);
    SnapshotSchema.parse(parsed);
    return { seq: latestSeq, path: fp, snapshot: parsed };
  } catch (err) {
    process.stderr.write(`[goal-mode] snapshot ${fp} unreadable, falling back: ${err.message}\n`);
    return null;
  }
}

/**
 * List all snapshots on disk in descending seq order. Used by gc + debug.
 */
export function listSnapshots(projectRoot) {
  const dir = snapshotsDir(projectRoot);
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return entries
    .map((name) => ({ name, seq: parseSnapshotSeq(name) }))
    .filter((e) => e.seq !== null)
    .sort((a, b) => b.seq - a.seq);
}

/**
 * Reconstruct {state, tree} via snapshot + tail replay.
 *
 * Algorithm:
 *   1. Find latest snapshot. If absent, replay from genesis.
 *   2. Read events newer than snapshot.seq.
 *   3. Run reducer(snapshot.tree, tail, snapshot.state).
 *
 * If no events.jsonl exists, returns the snapshot as-is (or null when
 * no snapshot either — caller must handle this case, typically by
 * falling back to the JSON cache or the initial tree).
 */
export function replayFromSnapshot(projectRoot, initialTree = null) {
  const latest = findLatestSnapshot(projectRoot);
  const allEvents = readEvents(projectRoot);
  if (!latest) {
    if (!initialTree) return null;
    return reduce(initialTree, allEvents);
  }
  const tail = allEvents.filter((e) => e.seq > latest.seq);
  return reduce(latest.snapshot.tree, tail, latest.snapshot.state);
}

/**
 * Garbage-collect old snapshots. Keeps the most recent `keep` files,
 * deletes everything older. Returns the number of files deleted.
 */
export function gcSnapshots(projectRoot, { keep = SNAPSHOT_KEEP } = {}) {
  const dir = snapshotsDir(projectRoot);
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  const sorted = entries
    .map((name) => ({ name, seq: parseSnapshotSeq(name) }))
    .filter((e) => e.seq !== null)
    .sort((a, b) => b.seq - a.seq);
  if (sorted.length <= keep) return 0;
  const toDelete = sorted.slice(keep);
  let removed = 0;
  for (const e of toDelete) {
    try {
      fs.unlinkSync(path.join(dir, e.name));
      removed += 1;
    } catch (_) { /* ignore */ }
  }
  return removed;
}

/**
 * Decide whether to write a snapshot now, given the events emitted in the
 * current turn and the seq before-and-after.
 *
 * Returns true when at least one of:
 *   - any event in `turnEvents` has kind 'cursor-advanced' or 'cleared'
 *   - (seqAfter % SNAPSHOT_INTERVAL) is closer to a multiple of SNAPSHOT_INTERVAL
 *     than seqBefore was — i.e., we crossed a SNAPSHOT_INTERVAL boundary
 *
 * Pure function; callable from tests.
 */
export function shouldSnapshot(turnEvents, seqBefore, seqAfter) {
  for (const e of turnEvents) {
    if (e.kind === 'cursor-advanced' || e.kind === 'cleared') return true;
  }
  if (seqBefore < 0) return false;
  const beforeMod = seqBefore % SNAPSHOT_INTERVAL;
  const afterMod = seqAfter % SNAPSHOT_INTERVAL;
  // Crossed a 50-boundary
  if (Math.floor(seqAfter / SNAPSHOT_INTERVAL) > Math.floor(seqBefore / SNAPSHOT_INTERVAL)) {
    return true;
  }
  return false;
}

/**
 * Convenience: write snapshot at the given seq, then gc to retention.
 * Called by the Stop hook + lifecycle commands after appendTurnEvents
 * when `shouldSnapshot` returns true.
 */
export function snapshotAndGc(projectRoot, seq, state, tree, opts = {}) {
  const written = writeSnapshot(projectRoot, seq, state, tree);
  const removed = gcSnapshots(projectRoot, opts);
  return { written, removed };
}
