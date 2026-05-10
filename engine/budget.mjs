/**
 * Triple-budget engine for goal-mode runtime.
 *
 * Two pure functions:
 *
 *   tallyTokens(transcriptPath: string): number
 *     Sum input_tokens + output_tokens + cache_creation_input_tokens across
 *     all assistant rows in the Claude Code session JSONL. The cache_read
 *     field is intentionally excluded because cache reads are billed at a
 *     fraction of the input rate; counting them inflates the token budget.
 *     Defensive: missing file / EISDIR / permission denied → returns 0;
 *     malformed JSON lines silently skipped; never throws (matches the
 *     pattern from engine/transcript.mjs::readLastAssistantText).
 *
 *   checkLimits(budget: object, now?: number): 'iterations' | 'tokens' | 'wallclock' | null
 *     Returns the name of the first axis that has been exhausted, or null
 *     when all three are within budget. Priority order: iterations → tokens
 *     → wallclock. Convention: max=0 means "no limit" on that axis.
 *     `now` parameter (default Date.now()) is injectable for testability —
 *     same pattern as buildContext / renderStatus / wallclockMinutes.
 *
 * Both functions are pure (no I/O beyond `tallyTokens`'s file read; no
 * globals; no Math.random). Used by `engine/stop-hook.mjs` to decide when
 * to render `prompts/budget-limit.md` for graceful exit.
 */

import fs from 'node:fs';

export function tallyTokens(transcriptPath) {
  let text;
  try {
    text = fs.readFileSync(transcriptPath, 'utf8');
  } catch {
    // Missing file (ENOENT), permission denied (EACCES), is-a-directory
    // (EISDIR), rotation race — all return 0. Matches the pattern
    // established in engine/transcript.mjs::readLastAssistantText.
    return 0;
  }
  let total = 0;
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      const obj = JSON.parse(line);
      if (obj.message?.role !== 'assistant') continue;
      const u = obj.message.usage;
      if (!u) continue;
      total += (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_creation_input_tokens || 0);
    } catch { /* skip malformed line */ }
  }
  return total;
}

export function checkLimits(budget, now = Date.now()) {
  if (budget.iterations.max > 0 && budget.iterations.used >= budget.iterations.max) {
    return 'iterations';
  }
  if (budget.tokens.max > 0 && budget.tokens.used >= budget.tokens.max) {
    return 'tokens';
  }
  if (budget.wallclock.max_seconds > 0) {
    const elapsed = (now - new Date(budget.wallclock.started_at).getTime()) / 1000;
    if (elapsed >= budget.wallclock.max_seconds) return 'wallclock';
  }
  return null;
}
