/**
 * Event log — append-only journal, ADR-0001 §File layout spec.
 *
 * v1.2.x shipped this module as a dual-write log with UUID v4 ids and a
 * narrow set of event kinds. v1.3.0 / v2.0.0-alpha1 hardens it to the
 * spec:
 *   - 15 canonical event kinds (see engine/event-payloads.mjs)
 *   - ULID ids (sortable, monotonic per millisecond)
 *   - Per-event schema_version (event-level evolution, not file-level)
 *   - goal_id header field (multi-goal-ready per ADR-0003)
 *   - Monotonic seq counter scoped to the goal
 *   - turn_id for transactional grouping
 *   - Per-kind payload zod validation on read + write
 *
 * Backward-compatibility: v1.2.x events.jsonl files have the OLD field
 * layout (`derived_from_tag`, no `seq`, no `turn_id`, no `goal_id`, UUID id,
 * legacy kind names). The `readEvents` function detects v1.2.x rows by
 * the absence of `seq` and either skips them or up-migrates them with
 * `MIGRATION_KIND_MAP`. Skipping is the default; up-migration is opt-in
 * via `readEvents(projectRoot, { migrate: true })` until v2.0.0 ships
 * its real one-shot migration script.
 */

import fs from 'node:fs';
import path from 'node:path';
import { ulid } from 'ulid';
import { z } from 'zod';
import { activeDir, goalsDir } from './paths.mjs';
import { EventKindSchema, validatePayload, PAYLOAD_SCHEMAS } from './event-payloads.mjs';

// Re-export EVENT_KINDS for back-compat with v1.2.x callers that imported it
// from this module. They now get the spec-compliant enum.
export { EventKindSchema as EVENT_KINDS };

// Rotation policy (carried from v1.2.1).
export const ROTATE_THRESHOLD = 200;
export const ROTATE_KEEP = 100;

// Event-level schema_version. Bump per-kind on payload change. Reducer
// dispatches on (kind, schema_version) so multiple live versions are
// tolerated during migration windows.
export const CURRENT_EVENT_SCHEMA_VERSION = 1;

// v1.2.x kind → v2.0.0 kind. Used for backward-compat read of legacy logs.
const MIGRATION_KIND_MAP = {
  'evidence-recorded': 'evidence-added',
  'goal-started': 'started',
  'review-verdict-accepted': 'audit-verdict-received',
  'review-verdict-rejected': 'audit-verdict-received',
  'blocker-set': 'node-blocked',
  'budget-tick': 'budget-tally',
  // unchanged kinds map to themselves implicitly
};

// Canonical event-log entry schema. Header + payload union.
export const EventLogEntrySchema = z.object({
  id: z.string().min(1),
  ts: z.string().datetime(),
  seq: z.number().int().nonnegative(),
  goal_id: z.string().min(1),
  schema_version: z.number().int().positive(),
  kind: EventKindSchema,
  turn_id: z.string().min(1).nullable(),
  payload: z.record(z.string(), z.unknown()),
});

const EVENTS_FILE = 'events.jsonl';

export function eventsPath(projectRoot) {
  return path.join(activeDir(projectRoot), EVENTS_FILE);
}

/**
 * Find the highest `seq` value in the current events.jsonl. Returns -1 when
 * the file is empty / missing — next append should use seq=0.
 *
 * Implementation: stream-read the file backward; the last well-formed JSON
 * line carries max(seq). We keep it simple and read the whole file: 200-line
 * cap from rotation policy means a typical scan is < 100KB.
 */
function nextSeq(projectRoot) {
  const fp = eventsPath(projectRoot);
  try {
    const raw = fs.readFileSync(fp, 'utf8');
    let maxSeq = -1;
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        if (typeof parsed?.seq === 'number' && parsed.seq > maxSeq) {
          maxSeq = parsed.seq;
        }
      } catch {
        // malformed line; skip
      }
    }
    return maxSeq + 1;
  } catch {
    return 0;
  }
}

/**
 * Append a single event to events.jsonl. Auto-fills id (ULID), ts, seq,
 * goal_id (from caller-provided context), schema_version. Validates the
 * payload against the kind's schema before write — invalid throws synchronously.
 *
 * The caller MUST hold the per-goal lock (ADR-0002) when calling this; the
 * lock guarantees `seq` is monotonic across concurrent writers. Without the
 * lock, two writers could call `nextSeq` simultaneously and collide.
 */
export function appendEvent(projectRoot, partial) {
  if (!partial.kind) throw new Error('appendEvent requires partial.kind');
  if (!partial.goal_id) throw new Error('appendEvent requires partial.goal_id');
  const payload = validatePayload(partial.kind, partial.payload ?? {});
  const event = {
    id: partial.id ?? ulid(),
    ts: partial.ts ?? new Date().toISOString(),
    seq: typeof partial.seq === 'number' ? partial.seq : nextSeq(projectRoot),
    goal_id: partial.goal_id,
    schema_version: partial.schema_version ?? CURRENT_EVENT_SCHEMA_VERSION,
    kind: partial.kind,
    turn_id: partial.turn_id ?? null,
    payload,
  };
  EventLogEntrySchema.parse(event);
  fs.mkdirSync(activeDir(projectRoot), { recursive: true });
  fs.appendFileSync(eventsPath(projectRoot), JSON.stringify(event) + '\n');
  maybeRotateEvents(projectRoot);
  return event;
}

/**
 * Append multiple events from the same turn atomically (single appendFileSync
 * call). All events share the same turn_id; seq values are consecutive.
 *
 * POSIX `write(2)` is atomic up to PIPE_BUF (4096 bytes on Linux/macOS) per
 * write call. Most turns fit within this — ~20 events at 200 bytes/event.
 * For larger turns we still use a single appendFileSync, which under the
 * hood may issue multiple writes — but the in-process buffer means the
 * kernel sees one buffer to write. Concurrent appenders interleave at the
 * file-system level, not within our buffer.
 */
export function appendTurnEvents(projectRoot, turnId, partials) {
  if (!turnId) throw new Error('appendTurnEvents requires turnId');
  if (!Array.isArray(partials) || partials.length === 0) return [];
  let nextS = nextSeq(projectRoot);
  const events = [];
  const lines = [];
  for (const p of partials) {
    if (!p.kind || !p.goal_id) {
      throw new Error('appendTurnEvents: every partial requires kind + goal_id');
    }
    const payload = validatePayload(p.kind, p.payload ?? {});
    const event = {
      id: p.id ?? ulid(),
      ts: p.ts ?? new Date().toISOString(),
      seq: nextS++,
      goal_id: p.goal_id,
      schema_version: p.schema_version ?? CURRENT_EVENT_SCHEMA_VERSION,
      kind: p.kind,
      turn_id: turnId,
      payload,
    };
    EventLogEntrySchema.parse(event);
    events.push(event);
    lines.push(JSON.stringify(event));
  }
  fs.mkdirSync(activeDir(projectRoot), { recursive: true });
  fs.appendFileSync(eventsPath(projectRoot), lines.join('\n') + '\n');
  maybeRotateEvents(projectRoot);
  return events;
}

/**
 * Read every event from disk. Malformed lines are skipped with a stderr
 * warning. v1.2.x rows (missing `seq`) are skipped by default; pass
 * `{ migrate: true }` to up-migrate them on read (best-effort, in-memory
 * only — never modifies disk).
 */
export function readEvents(projectRoot, { migrate = false } = {}) {
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
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      process.stderr.write(`[goal-mode] events.jsonl line ${lineNum} malformed: ${err.message}\n`);
      continue;
    }
    // v2.0+ shape: has seq + goal_id + turn_id + payload.
    if (typeof parsed?.seq === 'number') {
      try {
        EventLogEntrySchema.parse(parsed);
        events.push(parsed);
      } catch (err) {
        process.stderr.write(`[goal-mode] events.jsonl line ${lineNum} schema-invalid: ${err.message}\n`);
      }
      continue;
    }
    // v1.2.x shape: has `derived_from_tag`, no seq. Up-migrate on demand.
    if (!migrate) continue;
    const migrated = migrateLegacyEvent(parsed, lineNum, events.length);
    if (migrated) events.push(migrated);
  }
  // Sort by seq just in case the file was hand-edited; nextSeq guarantees
  // monotonic appends but defensive sort costs nothing on a 200-line cap.
  events.sort((a, b) => a.seq - b.seq);
  return events;
}

function migrateLegacyEvent(legacy, lineNum, fallbackSeq) {
  if (!legacy?.kind) return null;
  const mapped = MIGRATION_KIND_MAP[legacy.kind] ?? legacy.kind;
  if (!EventKindSchema.safeParse(mapped).success) {
    process.stderr.write(`[goal-mode] events.jsonl line ${lineNum} legacy kind "${legacy.kind}" not mappable; skipping\n`);
    return null;
  }
  // Construct a minimal valid v2 event from the legacy shape. Payload may
  // not match the new schema exactly — we pass it through and let the
  // reducer cope. Fail-open: callers reading legacy logs accept best-effort
  // reconstruction.
  return {
    id: legacy.id ?? ulid(),
    ts: legacy.ts ?? new Date().toISOString(),
    seq: typeof legacy.seq === 'number' ? legacy.seq : fallbackSeq,
    goal_id: legacy.goal_id ?? legacy.payload?.goal_id ?? 'unknown-legacy',
    schema_version: CURRENT_EVENT_SCHEMA_VERSION,
    kind: mapped,
    turn_id: null,
    payload: legacy.payload ?? {},
  };
}

/**
 * Last n events (or all). For UI / debugging.
 */
export function tailEvents(projectRoot, n) {
  const all = readEvents(projectRoot);
  return all.slice(Math.max(0, all.length - n));
}

/**
 * Count events on disk without fully validating each one. Used by the
 * doctor `event-log-present` check.
 */
export function countEvents(projectRoot) {
  const fp = eventsPath(projectRoot);
  try {
    const raw = fs.readFileSync(fp, 'utf8');
    return raw.split('\n').filter((l) => l.trim().length > 0).length;
  } catch {
    return 0;
  }
}

/**
 * Rotate active events.jsonl when it exceeds ROTATE_THRESHOLD lines.
 * Carried unchanged from v1.2.1.
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
