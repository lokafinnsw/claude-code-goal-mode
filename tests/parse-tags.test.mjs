import { describe, it, expect } from 'vitest';
import { parseTags } from '../engine/parse-tags.mjs';

describe('parseTags evidence', () => {
  it('parses self-closed <evidence ... />', () => {
    const text = '<evidence file="src/x.ts" line="42" criterion="0" note="works" />';
    expect(parseTags(text)).toEqual([
      { kind: 'evidence', file: 'src/x.ts', line: 42, criterion: 0, note: 'works', command: null, exit_code: null },
    ]);
  });

  it('parses paired <evidence ...>note</evidence>', () => {
    const text = '<evidence file="x" criterion="1">covers it</evidence>';
    expect(parseTags(text)).toEqual([
      { kind: 'evidence', file: 'x', line: null, criterion: 1, note: 'covers it', command: null, exit_code: null },
    ]);
  });

  it('parses command + exit_code form', () => {
    const text = '<evidence command="npm test" exit_code="0" criterion="2" note="green" />';
    expect(parseTags(text)).toEqual([
      { kind: 'evidence', file: null, line: null, criterion: 2, note: 'green', command: 'npm test', exit_code: 0 },
    ]);
  });

  it('skips malformed evidence (no criterion attr)', () => {
    const text = '<evidence file="x" />';
    expect(parseTags(text)).toEqual([]);
  });

  it('parses multiple evidence in one text', () => {
    const text = '<evidence criterion="0" note="a" /> blah <evidence criterion="1" note="b" />';
    const out = parseTags(text);
    expect(out.length).toBe(2);
    expect(out.map(t => t.criterion)).toEqual([0, 1]);
  });
});
