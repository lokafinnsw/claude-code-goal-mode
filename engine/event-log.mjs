/**
 * Event log — append-only journal of every state mutation.
 *
 * Design: instead of imperative mutation of state.json + tree.json (the
 * historical v1 path), every change is appended to events.jsonl as a single
 * timestamped record. The on-disk state/tree files become a derived
 * snapshot of "everything before this point"; they can be rebuilt from the
 * event log at any time (see state-from-events.mjs).
 *
 * Why: the "engine встал" bug class came from partial mutations + zod throws
 * + silent catch handlers. An append-only journal makes that impossible —
 * each event is either fully written or not written, and replay from any
 * recoverable starting point produces a deterministic result.
 *
 * File: .claude/goals/active/events.jsonl
 *   - One JSON object per line.
 *   - Strict zod-validated schema (EventLogEntrySchema).
 *   - Append-only contract: appendEvent never rewrites or truncates.
 *
 * v1.2.0 introduces this as a DUAL-WRITE layer alongside the existing
 * tree.evidence/state.history mutation path. A future migration can collapse
 * to event-log-only once we trust the replay path in production. The doctor
 * command (Epic 1) exposes "state-recovered-from-event-log" so this path is
 * visible when it fires.
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { activeDir, goalsDir } from './paths.mjs';

// Retention: when active events.jsonl grows past ROTATE_THRESHOLD lines,
// move the oldest half to .claude/goals/archive/events-<ISO>.jsonl. Keeps
// the active file bounded so reads and replays stay linear in REPLAY_HEAD.
export const ROTATE_THRESHOLD = 200;
export const ROTATE_KEEP = 100;

export const EVENT_KINDS = z.enum([
  'goal-started',
  'evidence-recorded',
  'task-status-set',
  'review-requested',
  'review-verdict-accepted',
  'review-verdict-rejected',
  'cursor-advanced',
  'blocker-set',
  'session-rebound',
  'lifecycle-changed',
  'budget-tick',
]);

export const EventLogEntrySchema = z.object({
  id: z.string().min(1),
  ts: z.string().datetime(),
  iteration: z.number().int().nonnegative(),
  kind: EVENT_KINDS,
  payload: z.record(z.string(), z.unknown()),
  derived_from_tag: z.string().nullable(),
});

const EVENTS_FILE = 'events.jsonl';

function eventsPath(projectRoot) {
  return path.join(activeDir(projectRoot), EVENTS_FILE);
}

/**
 * Append a single event to the project's events.jsonl. Atomic at the line
 * level (one fs.appendFileSync call), so concurrent processes can interleave
 * without corruption — the worst case is reordering, not partial writes.
 *
 * Auto-fills id (uuid) and ts (now-iso) when omitted. Validates via zod
 * before write — a malformed event throws synchronously and is NOT written.
 */
export function appendEvent(projectRoot, partial) {
  const event = {
    id: partial.id ?? randomUUID(),
    ts: partial.ts ?? new Date().toISOString(),
    iteration: partial.iteration ?? 0,
    kind: partial.kind,
    payload: partial.payload ?? {},
    derived_from_tag: partial.derived_from_tag ?? null,
  };
  EventLogEntrySchema.parse(event); // throws on invalid
  fs.mkdirSync(activeDir(projectRoot), { recursive: true });
  fs.appendFileSync(eventsPath(projectRoot), JSON.stringify(event) + '\n');
  maybeRotateEvents(projectRoot);
  return event;
}

/**
 * Rotate the active events.jsonl when it exceeds ROTATE_THRESHOLD lines.
 * Older half is moved to .claude/goals/archive/events-<ISO>.jsonl. The
 * active file is rewritten with only the most-recent ROTATE_KEEP entries.
 *
 * This is best-effort — failure to rotate does NOT throw (the append already
 * succeeded; rotation is a maintenance task that can retry next append).
 */
export function maybeRotateEvents(projectRoot) {
  try {
    const fp = eventsPath(projectRoot);
    const raw = fs.readFileSync(fp, 'utf8');
    const lines = raw.split('\n').filter((l) => l.trim().length > 0);
    if (lines.length <= ROTATE_THRESHOLD) return false;
    const cut = lines.length - ROTATE_KEEP;
    const archived = lines.slice(0, cut);
    const kept = lines.slice(cut);
    const archiveRoot = path.join(goalsDir(projectRoot), 'archive');
    fs.mkdirSync(archiveRoot, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const archivePath = path.join(archiveRoot, `events-${ts}.jsonl`);
    fs.writeFileSync(archivePath, archived.join('\n') + '\n');
    const tmp = fp + '.tmp';
    fs.writeFileSync(tmp, kept.join('\n') + '\n');
    fs.renameSync(tmp, fp);
    return true;
  } catch (err) {
    process.stderr.write(`[goal-mode] event-log rotation failed (non-fatal): ${err.message}\n`);
    return false;
  }
}

/**
 * Read all events from disk. Missing file → empty array. Malformed lines
 * are reported via console.error but skipped (replay should not crash on
 * partial-corruption — graceful degradation is what makes recovery work).
 */
export function readEvents(projectRoot) {
  const fp = eventsPath(projectRoot);
  let raw;
  try {
    raw = fs.readFileSync(fp, 'utf8');
  } catch {
    return [];
  }
  const events = [];
  let lineNum = 0;
  for (const line of raw.split('\n')) {
    lineNum += 1;
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      EventLogEntrySchema.parse(parsed);
      events.push(parsed);
    } catch (err) {
      console.error(`[goal-mode] events.jsonl line ${lineNum} malformed, skipping: ${err.message}`);
    }
  }
  return events;
}

/**
 * Last n events (or all, if fewer). For UI / debugging.
 */
export function tailEvents(projectRoot, n) {
  const all = readEvents(projectRoot);
  return all.slice(Math.max(0, all.length - n));
}

/**
 * Convenience: re-export the eventsPath helper for callers that need to
 * inspect or backup the file directly (doctor, migrations, manual scripts).
 */
export { eventsPath };
