/**
 * Reader for the last assistant text-block in a Claude Code session JSONL
 * transcript.
 *
 * Purpose: the Phase-4 Stop-hook needs to extract "the assistant's final
 * text" from the just-completed turn so it can be parsed for tags
 * (<evidence>, <task-status>, etc.) by `parse-tags.mjs`. This module owns
 * that extraction, isolated from parsing concerns.
 *
 * Schema assumption (Claude Code session transcript):
 *   Each non-empty line is a JSON object shaped roughly as
 *     {
 *       "message": {
 *         "role": "user" | "assistant" | ...,
 *         "content": [
 *           { "type": "text", "text": "..." },
 *           { "type": "tool_use", ... },
 *           ...
 *         ]
 *       },
 *       ... other fields ignored ...
 *     }
 *   Other line shapes (no `message`, non-array `content`, missing `role`)
 *   are silently skipped.
 *
 * Return value:
 *   The text from the LAST `assistant` message that contains a `text`-typed
 *   block. If a single assistant message has multiple text blocks, the LAST
 *   one within that message wins — consistent with Claude's notion of "the
 *   assistant's final text" for that turn (text after tool-use is the
 *   summary the agent leaves for the next turn).
 *
 * Error handling:
 *   - Missing file              → returns ''.
 *   - Malformed JSON line       → that line silently skipped, scan continues.
 *   - No assistant text present → returns ''.
 *   Never throws. Drops the existsSync pre-check to eliminate a TOCTOU
 *   race; any I/O error (ENOENT, EACCES, EISDIR, rotation) returns ''.
 *
 * Pure-ish: side effects limited to a single synchronous file read.
 */

import fs from 'node:fs';

export function readLastAssistantText(transcriptPath) {
  let text;
  try {
    text = fs.readFileSync(transcriptPath, 'utf8');
  } catch {
    // Missing file (ENOENT), permission denied (EACCES), is-a-directory
    // (EISDIR), rotation race — all of these manifest at the boundary
    // between Claude Code writing the transcript and the Stop hook reading
    // it. Returning '' is the documented "never throws" contract.
    return '';
  }
  const lines = text.split('\n').filter(Boolean);
  let last = '';
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (obj.message?.role !== 'assistant') continue;
      const blocks = obj.message?.content;
      if (!Array.isArray(blocks)) continue;
      for (const b of blocks) {
        if (b?.type === 'text' && typeof b.text === 'string') last = b.text;
      }
    } catch { /* skip malformed line */ }
  }
  return last;
}
