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
