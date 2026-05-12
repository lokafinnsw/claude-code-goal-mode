/**
 * Incremental transcript scan checkpoint (bugs C3 + C4 + I6 from 2026-05-11 audit).
 *
 * Problem fixed:
 *
 *   Pre-v2.0.3, every Stop-hook tick called `tallyTokens(transcript_path)`
 *   and `scanAgentInvocations(transcript_path, sinceTs)`, each of which
 *   `fs.readFileSync`s the ENTIRE transcript JSONL and parses every line. On
 *   long sessions transcripts grow to tens or hundreds of megabytes — every
 *   Stop hook then re-reads + re-parses everything. Measurable lag on every
 *   user turn for long-running goals.
 *
 *   Also, when Claude Code rotates the transcript (e.g., across /compact or
 *   a session boundary), `tallyTokens` recounts from zero — the cached
 *   `state.budget.tokens.used` is overwritten with a smaller value, which
 *   under-counts and lets the goal silently overshoot its token budget.
 *
 *   And `scanAgentInvocations` fail-open semantics (when a transcript line
 *   lacks a `timestamp` field, the entry was kept regardless of `sinceTs`)
 *   meant any historic Agent invocation could falsely vouch for the current
 *   turn's reviewer dispatch.
 *
 * Solution:
 *
 *   Persist a checkpoint at `<projectRoot>/.claude/goals/active/.transcript-cache.json`
 *   that records:
 *     - offset_bytes:        next byte to read on the next tick
 *     - tokens_total:        total tokens up to offset (monotonic)
 *     - fingerprint:         sha-256 of the first 256 bytes of the transcript;
 *                            mismatches mean the transcript was rotated/replaced
 *     - size_bytes:          last known size; current_size < this means
 *                            truncation, also a rotation signal
 *     - agent_dispatches[]:  every `Agent(subagent_type=...)` tool_use seen,
 *                            tagged with the entry's `timestamp` (if present)
 *
 *   On each Stop-hook tick:
 *     1. Stat the transcript. If size < cached.size OR first-256-bytes hash
 *        mismatches cached.fingerprint → ROTATION detected. Reset checkpoint,
 *        scan from byte 0. The previous tokens_total is preserved as a
 *        `max(carry_over, fresh_total)` floor so we don't undercount across
 *        rotations (bug C4 fix).
 *     2. Read bytes [offset, current_size) into memory. Parse JSONL lines
 *        (rewinding to last newline to avoid splitting a partial trailing
 *        line).
 *     3. For each line: if assistant message with usage → add to tokens. If
 *        Agent tool_use → push `{ ts, subagent_type }` onto agent_dispatches.
 *     4. Persist new checkpoint via atomic write (caller holds the per-goal
 *        lock so the write doesn't race the next tick).
 *
 *   `scanAgentInvocationsIncremental(projectRoot, transcriptPath, sinceTs)`
 *   returns the Set of subagent_types in agent_dispatches with
 *   `ts >= sinceTs`. Entries WITHOUT a ts are now FAIL-CLOSED (excluded)
 *   instead of fail-open (bug I6 fix). The probability of a real Agent
 *   tool_use lacking a timestamp in CC's transcript shape is effectively
 *   zero; the prior fail-open was defensive coding that turned out to be a
 *   reviewer-independence bypass.
 *
 *   `tallyTokensSafe(projectRoot, transcriptPath, fallbackPreviousTotal)`
 *   returns the running monotonic-floor token total. Caller passes the
 *   previously-stored `state.budget.tokens.used` so that on rotation the
 *   cached total is preserved as a floor.
 *
 * Schema versioning:
 *
 *   `schema_version: 1`. Future changes must bump and add migration code in
 *   loadCheckpoint. Missing/corrupt checkpoint files are treated as
 *   "first run" and rebuilt from byte 0 — never throws.
 *
 * Pure-ish: the module owns file I/O for the checkpoint file and the
 * transcript file. No globals. No Math.random.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { activeDir } from './paths.mjs';

const CHECKPOINT_FILENAME = '.transcript-cache.json';
const FINGERPRINT_BYTES = 256;
const CHECKPOINT_SCHEMA_VERSION = 1;
// Cap the in-memory dispatches list — long-lived goals would otherwise grow
// it unboundedly. 10k Agent dispatches is well above any plausible goal
// (most goals see <100); we drop the oldest entries past this cap.
const AGENT_DISPATCHES_CAP = 10_000;

function checkpointPath(projectRoot) {
  return path.join(activeDir(projectRoot), CHECKPOINT_FILENAME);
}

function emptyCheckpoint() {
  return {
    schema_version: CHECKPOINT_SCHEMA_VERSION,
    offset_bytes: 0,
    tokens_total: 0,
    fingerprint: null,
    size_bytes: 0,
    agent_dispatches: [],
  };
}

/**
 * Load the checkpoint file. Returns a fresh empty checkpoint when the file
 * is missing, malformed, or schema-incompatible. Never throws.
 */
export function loadCheckpoint(projectRoot) {
  let raw;
  try {
    raw = fs.readFileSync(checkpointPath(projectRoot), 'utf8');
  } catch {
    return emptyCheckpoint();
  }
  try {
    const parsed = JSON.parse(raw);
    if (
      typeof parsed?.schema_version !== 'number'
      || parsed.schema_version !== CHECKPOINT_SCHEMA_VERSION
      || typeof parsed.offset_bytes !== 'number'
      || typeof parsed.tokens_total !== 'number'
      || typeof parsed.size_bytes !== 'number'
      || !Array.isArray(parsed.agent_dispatches)
    ) {
      return emptyCheckpoint();
    }
    return parsed;
  } catch {
    return emptyCheckpoint();
  }
}

/**
 * Atomic write of the checkpoint file. Caller MUST hold the per-goal lock.
 */
export function saveCheckpoint(projectRoot, checkpoint) {
  const dir = activeDir(projectRoot);
  fs.mkdirSync(dir, { recursive: true });
  const fp = checkpointPath(projectRoot);
  const tmp = fp + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(checkpoint, null, 2));
  fs.renameSync(tmp, fp);
}

function computeFingerprint(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/**
 * Read the first FINGERPRINT_BYTES bytes (or less if the file is shorter)
 * and return their sha-256. Returns null on read error.
 */
function readFingerprint(transcriptPath, sizeBytes) {
  if (sizeBytes <= 0) return null;
  const fd = fs.openSync(transcriptPath, 'r');
  try {
    const buf = Buffer.alloc(Math.min(sizeBytes, FINGERPRINT_BYTES));
    fs.readSync(fd, buf, 0, buf.length, 0);
    return computeFingerprint(buf);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Read bytes [offset, size) from the transcript file. Handles the trailing
 * line carefully:
 *
 *   - If the slice ends in `\n`: trivially complete, consume all of it.
 *   - If the slice has at least one `\n` but ends without one: try to
 *     JSON.parse the trailing remainder. If parse succeeds, the line is
 *     complete (CC wrote it without a final newline) and we consume the
 *     entire slice. If parse fails, treat the remainder as a partial
 *     in-progress write and only consume up to the last `\n`.
 *   - If the slice has no `\n` at all: try to JSON.parse the whole slice.
 *     Succeed → consume; fail → leave offset unchanged for retry next tick.
 *
 * Returns `{ text, next_offset }`. The returned text always contains only
 * complete JSON lines (or is empty). On error returns `{ text: '', next_offset: offset }`.
 */
function readTranscriptSlice(transcriptPath, offset, size) {
  if (size <= offset) return { text: '', next_offset: offset };
  const length = size - offset;
  const fd = fs.openSync(transcriptPath, 'r');
  try {
    const buf = Buffer.alloc(length);
    const read = fs.readSync(fd, buf, 0, length, offset);
    const slice = buf.slice(0, read).toString('utf8');
    if (slice.endsWith('\n')) {
      return { text: slice, next_offset: offset + read };
    }
    const lastNl = slice.lastIndexOf('\n');
    const trailing = lastNl < 0 ? slice : slice.slice(lastNl + 1);
    let trailingComplete = false;
    if (trailing.trim().length > 0) {
      try {
        JSON.parse(trailing);
        trailingComplete = true;
      } catch {
        trailingComplete = false;
      }
    }
    if (trailingComplete) {
      return { text: slice, next_offset: offset + read };
    }
    if (lastNl < 0) {
      // No complete line at all yet — wait for next tick.
      return { text: '', next_offset: offset };
    }
    return { text: slice.slice(0, lastNl + 1), next_offset: offset + lastNl + 1 };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Parse a JSONL slice and extract usage tokens + Agent invocations + total
 * tool_use block count.
 *
 * Token math mirrors engine/budget.mjs::tallyTokens — sum of input_tokens +
 * output_tokens + cache_creation_input_tokens on assistant rows. The
 * cache_read field is intentionally excluded (billed at a fraction of input
 * rate; counting it inflates the budget — see budget.mjs jsdoc).
 *
 * v3.0.6: also counts ALL tool_use blocks (not just Agent). The Stop hook
 * uses this as a secondary engagement signal so multi-turn exploration
 * (Bash/Read/Edit/etc.) doesn't false-positive auto-pause-on-silence.
 *
 * Returns `{ tokens_added, dispatches_added: [...], tool_use_count }`.
 * Never throws on malformed lines (skip + continue).
 */
function parseSlice(text) {
  let tokensAdded = 0;
  let toolUseCount = 0;
  const dispatchesAdded = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (obj?.message?.role === 'assistant') {
      const u = obj.message.usage;
      if (u) {
        tokensAdded += (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_creation_input_tokens || 0);
      }
    }
    const blocks = obj?.message?.content;
    if (!Array.isArray(blocks)) continue;
    for (const b of blocks) {
      if (b?.type !== 'tool_use') continue;
      // v3.0.6: every tool_use block contributes to the engagement counter,
      // regardless of name. Bash/Read/Edit/Grep/Agent/etc. all count.
      toolUseCount += 1;
      const name = b.name ?? b.tool_name ?? '';
      if (name !== 'Agent' && name !== 'agent') continue;
      const t = b.input?.subagent_type ?? b.input?.subagentType;
      if (typeof t !== 'string' || t.length === 0) continue;
      // Fail-closed on missing timestamp (bug I6 fix). The probability of a
      // real CC transcript row missing top-level `timestamp` is effectively
      // zero; if the row has no ts we record it with ts=null, which the
      // sinceTs filter will treat as "older than any sinceTs" → excluded.
      const ts = typeof obj?.timestamp === 'string' ? obj.timestamp : null;
      dispatchesAdded.push({ ts, subagent_type: t });
    }
  }
  return { tokens_added: tokensAdded, dispatches_added: dispatchesAdded, tool_use_count: toolUseCount };
}

/**
 * Advance the checkpoint by scanning newly-written transcript bytes.
 *
 * Returns the updated `{ checkpoint, rotated }`. `rotated` is true when the
 * transcript was detected to have shrunk or been replaced (fingerprint
 * mismatch) — useful for diagnostic logging at the call site.
 *
 * On rotation, the prior `tokens_total` is preserved as a floor: the
 * checkpoint is reset and re-scanned from byte 0, then tokens_total =
 * max(carry_over, fresh_total). This is the bug C4 fix — pre-v2.0.3 a
 * rotation would silently drop the cumulative token count back to whatever
 * the new transcript reports.
 *
 * The caller MUST hold the per-goal lock for the duration of this function
 * + the subsequent saveCheckpoint(). Otherwise concurrent Stop-hook ticks
 * would each rebuild the checkpoint from stale state.
 */
export function advanceCheckpoint(projectRoot, transcriptPath) {
  const cached = loadCheckpoint(projectRoot);
  let size;
  try {
    size = fs.statSync(transcriptPath).size;
  } catch {
    // Transcript missing/inaccessible — return the cached checkpoint
    // unchanged. Caller uses cached counters as the best-effort source.
    return { checkpoint: cached, rotated: false, tool_use_count: 0 };
  }
  let working = cached;
  let rotated = false;
  // Rotation detection: shrinkage OR fingerprint mismatch.
  if (size < working.size_bytes) {
    rotated = true;
  } else if (working.fingerprint != null) {
    const currentFp = readFingerprint(transcriptPath, size);
    if (currentFp !== working.fingerprint) {
      rotated = true;
    }
  }
  let tokensFloor = 0;
  if (rotated) {
    tokensFloor = working.tokens_total; // preserve as floor (bug C4)
    working = emptyCheckpoint();
    // agent_dispatches reset on rotation — old ts's no longer apply to a
    // freshly-rotated transcript anyway. The reviewer-independence check
    // uses sinceTs which post-dates the rotation in practice.
  }
  if (working.fingerprint == null && size > 0) {
    working.fingerprint = readFingerprint(transcriptPath, size);
  }
  // v3.0.6: tool_use_count is the count of tool_use blocks parsed in THIS
  // scan window only (current tick). It is intentionally NOT persisted in
  // the checkpoint — engagement is a per-turn signal, not cumulative.
  let toolUseCount = 0;
  if (size > working.offset_bytes) {
    const { text, next_offset } = readTranscriptSlice(transcriptPath, working.offset_bytes, size);
    if (text) {
      const { tokens_added, dispatches_added, tool_use_count } = parseSlice(text);
      working.tokens_total += tokens_added;
      toolUseCount = tool_use_count;
      for (const d of dispatches_added) working.agent_dispatches.push(d);
      // Cap the dispatches list size to prevent unbounded growth on long
      // goals. Drop oldest. This is a memory-safety bound, not a correctness
      // concern — sinceTs filtering means agents older than the last
      // cursor-advance are never consulted.
      if (working.agent_dispatches.length > AGENT_DISPATCHES_CAP) {
        working.agent_dispatches = working.agent_dispatches.slice(-AGENT_DISPATCHES_CAP);
      }
      working.offset_bytes = next_offset;
    }
  }
  working.size_bytes = size;
  if (tokensFloor > working.tokens_total) {
    working.tokens_total = tokensFloor;
  }
  return { checkpoint: working, rotated, tool_use_count: toolUseCount };
}

/**
 * Filter dispatches[] down to a Set<subagent_type> of entries with ts >= sinceTs.
 * Fail-closed on missing ts (bug I6 fix). Pure function — no I/O.
 */
function filterDispatchesByTs(dispatches, sinceTs) {
  const found = new Set();
  if (!sinceTs) {
    for (const d of dispatches) found.add(d.subagent_type);
    return found;
  }
  const sinceMs = new Date(sinceTs).getTime();
  if (!Number.isFinite(sinceMs)) {
    for (const d of dispatches) found.add(d.subagent_type);
    return found;
  }
  for (const d of dispatches) {
    if (!d.ts) continue;
    const t = new Date(d.ts).getTime();
    if (Number.isFinite(t) && t >= sinceMs) found.add(d.subagent_type);
  }
  return found;
}

/**
 * Single-pass advance + tally + scan. Used by the Stop hook to do all
 * checkpoint work in ONE disk read of the transcript per turn — calling
 * `advanceCheckpoint` separately for tokens then for agents would double-
 * read and discard intermediate checkpoint state.
 *
 * v3.0.6: extend the scan to surface `tool_use_count` for the current tick.
 * The auto-pause-on-silence detector previously treated "no goal-mode tag
 * emission this turn" as silence, which false-positived on legitimate
 * controller work (Bash/Read/Edit/Agent turns during exploration phases).
 * Counting any tool_use as engagement matches the controller's actual
 * activity. The count is per-tick (NOT cumulative); intent is "did the
 * controller use any tools in the window just scanned?".
 *
 * Returns `{ tokens, agents, tool_use_count, rotated, checkpoint }`.
 * Caller persists checkpoint via `saveCheckpoint` AFTER the rest of the
 * Stop-hook work succeeds, so a mid-turn crash leaves the previous
 * checkpoint intact and the next tick re-scans the same window.
 */
export function advanceTallyScan(projectRoot, transcriptPath, sinceTs, fallbackPreviousTotal = 0) {
  const { checkpoint, rotated, tool_use_count } = advanceCheckpoint(projectRoot, transcriptPath);
  const tokens = Math.max(checkpoint.tokens_total, fallbackPreviousTotal | 0);
  const agents = filterDispatchesByTs(checkpoint.agent_dispatches, sinceTs);
  return { tokens, agents, tool_use_count, rotated, checkpoint };
}

/**
 * Compute and persist the next token count. The function the Stop hook
 * used to call in place of `tallyTokens(transcriptPath)`. PREFER
 * `advanceTallyScan` which combines this with the agent scan.
 *
 * `fallbackPreviousTotal` is `state.budget.tokens.used` from the loaded
 * state — used as an additional rotation floor in case the checkpoint
 * itself was deleted while state.json survived (e.g., user ran
 * `rm .claude/goals/active/.transcript-cache.json`). Otherwise we'd
 * silently reset the cumulative count.
 *
 * Returns `{ tokens, rotated, checkpoint }`. Caller persists checkpoint
 * via saveCheckpoint after the rest of the Stop-hook work is done.
 */
export function tallyTokensViaCheckpoint(projectRoot, transcriptPath, fallbackPreviousTotal = 0) {
  const { checkpoint, rotated } = advanceCheckpoint(projectRoot, transcriptPath);
  const tokens = Math.max(checkpoint.tokens_total, fallbackPreviousTotal | 0);
  return { tokens, rotated, checkpoint };
}

/**
 * Return the Set of subagent_types from the cached agent_dispatches whose
 * `ts` is >= sinceTs. Entries with `ts: null` are FAIL-CLOSED (excluded)
 * unless `sinceTs` itself is null/falsy (in which case all entries pass).
 *
 * PREFER `advanceTallyScan` for the Stop hook — calling this separately
 * after `tallyTokensViaCheckpoint` double-advances the checkpoint.
 */
export function scanAgentInvocationsIncremental(projectRoot, transcriptPath, sinceTs) {
  const { checkpoint } = advanceCheckpoint(projectRoot, transcriptPath);
  const found = filterDispatchesByTs(checkpoint.agent_dispatches, sinceTs);
  return { agents: found, checkpoint };
}
