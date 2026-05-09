import { describe, it, expect } from 'vitest';
import { readLastAssistantText } from '../engine/transcript.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function tmpfile(content) {
  const f = path.join(os.tmpdir(), `transcript-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
  fs.writeFileSync(f, content);
  return f;
}

describe('readLastAssistantText', () => {
  it('returns the last assistant text block', () => {
    const f = tmpfile([
      JSON.stringify({ message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } }),
      JSON.stringify({ message: { role: 'assistant', content: [{ type: 'text', text: 'first' }] } }),
      JSON.stringify({ message: { role: 'assistant', content: [{ type: 'tool_use' }] } }),
      JSON.stringify({ message: { role: 'assistant', content: [{ type: 'text', text: 'last' }] } }),
    ].join('\n'));
    expect(readLastAssistantText(f)).toBe('last');
  });

  it('returns empty string when no assistant text present', () => {
    const f = tmpfile(JSON.stringify({ message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } }));
    expect(readLastAssistantText(f)).toBe('');
  });

  it('returns empty string when file is missing', () => {
    expect(readLastAssistantText('/nonexistent')).toBe('');
  });
});

describe('readLastAssistantText hardening', () => {
  it('returns the LAST text block within a single multi-block assistant message (in-message last-wins)', () => {
    const f = tmpfile(JSON.stringify({
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'first' },
          { type: 'tool_use' },
          { type: 'text', text: 'second' },
        ],
      },
    }));
    expect(readLastAssistantText(f)).toBe('second');
  });

  it('skips malformed JSON lines and returns last valid assistant text', () => {
    const f = tmpfile([
      JSON.stringify({ message: { role: 'assistant', content: [{ type: 'text', text: 'before' }] } }),
      'not valid json {{{',
      JSON.stringify({ message: { role: 'assistant', content: [{ type: 'text', text: 'after' }] } }),
    ].join('\n'));
    expect(readLastAssistantText(f)).toBe('after');
  });

  it('returns empty string when transcript path is a directory (EISDIR) — never throws', () => {
    expect(readLastAssistantText(os.tmpdir())).toBe('');
  });
});
