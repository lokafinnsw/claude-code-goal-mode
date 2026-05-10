import { describe, it, expect } from 'vitest';
import { tallyTokens, checkLimits } from '../engine/budget.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function tmpJsonl(rows) {
  const f = path.join(os.tmpdir(), `tally-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
  fs.writeFileSync(f, rows.map(r => JSON.stringify(r)).join('\n'));
  return f;
}

describe('tallyTokens', () => {
  it('sums input + output + cache_creation across assistant rows (cache_read excluded — it is read-only billing)', () => {
    const f = tmpJsonl([
      { message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } },
      { message: { role: 'assistant', usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 10, cache_read_input_tokens: 200 } } },
      { message: { role: 'assistant', usage: { input_tokens: 150, output_tokens: 75, cache_creation_input_tokens: 0, cache_read_input_tokens: 100 } } },
    ]);
    expect(tallyTokens(f)).toBe(100 + 50 + 10 + 150 + 75 + 0);
  });

  it('returns 0 when file missing', () => {
    expect(tallyTokens('/nonexistent/path/abcdef')).toBe(0);
  });

  it('returns 0 when path is a directory (EISDIR — never throws)', () => {
    expect(tallyTokens(os.tmpdir())).toBe(0);
  });

  it('skips malformed JSON lines', () => {
    const f = tmpJsonl([
      { message: { role: 'assistant', usage: { input_tokens: 100, output_tokens: 50 } } },
    ]);
    fs.appendFileSync(f, '\nnot valid json\n');
    fs.appendFileSync(f, JSON.stringify({ message: { role: 'assistant', usage: { input_tokens: 50, output_tokens: 25 } } }));
    expect(tallyTokens(f)).toBe(100 + 50 + 50 + 25);
  });

  it('skips assistant rows without usage object', () => {
    const f = tmpJsonl([
      { message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } },  // no usage
      { message: { role: 'assistant', usage: { input_tokens: 100, output_tokens: 50 } } },
    ]);
    expect(tallyTokens(f)).toBe(150);
  });

  it('skips non-assistant rows', () => {
    const f = tmpJsonl([
      { message: { role: 'user', usage: { input_tokens: 999 } } },  // user has no real usage
      { message: { role: 'system', usage: { input_tokens: 999 } } },
      { message: { role: 'assistant', usage: { input_tokens: 100, output_tokens: 50 } } },
    ]);
    expect(tallyTokens(f)).toBe(150);
  });

  it('handles empty file gracefully', () => {
    const f = tmpJsonl([]);
    expect(tallyTokens(f)).toBe(0);
  });

  it('handles partial usage fields (missing fields default to 0)', () => {
    const f = tmpJsonl([
      { message: { role: 'assistant', usage: { input_tokens: 100 } } },  // only input
      { message: { role: 'assistant', usage: { output_tokens: 50 } } },  // only output
      { message: { role: 'assistant', usage: { cache_creation_input_tokens: 25 } } },  // only cache_creation
    ]);
    expect(tallyTokens(f)).toBe(100 + 50 + 25);
  });
});

describe('checkLimits', () => {
  const baseBudget = (now = Date.now()) => ({
    iterations: { used: 0, max: 100 },
    tokens: { used: 0, max: 1000 },
    wallclock: { started_at: new Date(now).toISOString(), max_seconds: 600 },
  });

  it('returns null when no limit hit', () => {
    expect(checkLimits(baseBudget())).toBeNull();
  });

  it('returns "iterations" when iter exhausted (>=)', () => {
    const b = baseBudget();
    b.iterations.used = b.iterations.max;
    expect(checkLimits(b)).toBe('iterations');
  });

  it('returns "iterations" when iter exceeds max', () => {
    const b = baseBudget();
    b.iterations.used = b.iterations.max + 5;
    expect(checkLimits(b)).toBe('iterations');
  });

  it('returns "tokens" when tokens exhausted', () => {
    const b = baseBudget();
    b.tokens.used = b.tokens.max;
    expect(checkLimits(b)).toBe('tokens');
  });

  it('returns "wallclock" when elapsed exceeds max (with injectable now)', () => {
    const startedAt = '2026-05-09T22:00:00.000Z';
    const now = new Date('2026-05-09T22:11:00.000Z').getTime();  // 11 min elapsed
    const b = {
      iterations: { used: 0, max: 100 },
      tokens: { used: 0, max: 1000 },
      wallclock: { started_at: startedAt, max_seconds: 600 },  // 10 min max
    };
    expect(checkLimits(b, now)).toBe('wallclock');
  });

  it('treats max=0 as "no limit" for iterations', () => {
    const b = baseBudget();
    b.iterations.max = 0;
    b.iterations.used = 999;
    expect(checkLimits(b)).toBeNull();
  });

  it('treats max=0 as "no limit" for tokens', () => {
    const b = baseBudget();
    b.tokens.max = 0;
    b.tokens.used = 999_999;
    expect(checkLimits(b)).toBeNull();
  });

  it('treats max_seconds=0 as "no limit" for wallclock', () => {
    const startedAt = '2026-05-09T22:00:00.000Z';
    const now = new Date('2027-05-09T22:00:00.000Z').getTime();  // 1 year elapsed
    const b = {
      iterations: { used: 0, max: 100 },
      tokens: { used: 0, max: 1000 },
      wallclock: { started_at: startedAt, max_seconds: 0 },
    };
    expect(checkLimits(b, now)).toBeNull();
  });

  it('checks in priority order: iterations → tokens → wallclock', () => {
    const startedAt = new Date(Date.now() - 700_000).toISOString();
    const b = {
      iterations: { used: 100, max: 100 },  // exhausted
      tokens: { used: 1000, max: 1000 },     // also exhausted
      wallclock: { started_at: startedAt, max_seconds: 600 },  // also exhausted
    };
    // iter checked first → returns 'iterations'.
    expect(checkLimits(b)).toBe('iterations');
  });

  it('uses Date.now() as default for now parameter', () => {
    const b = baseBudget();
    expect(checkLimits(b)).toBeNull();
  });

  it('treats invalid started_at as "no wallclock limit" (defensive against corrupt state)', () => {
    const b = {
      iterations: { used: 0, max: 100 },
      tokens: { used: 0, max: 1000 },
      wallclock: { started_at: 'not-a-date', max_seconds: 600 },
    };
    expect(checkLimits(b)).toBeNull();
  });

  it('treats empty started_at string as "no wallclock limit"', () => {
    const b = {
      iterations: { used: 0, max: 100 },
      tokens: { used: 0, max: 1000 },
      wallclock: { started_at: '', max_seconds: 600 },
    };
    expect(checkLimits(b)).toBeNull();
  });
});
