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

describe('parseTags status / blocker / review / verdict', () => {
  it('parses <task-status>', () => {
    expect(parseTags('<task-status>achieved</task-status>')).toEqual([
      { kind: 'task-status', value: 'achieved' },
    ]);
  });

  it('rejects unknown task-status values', () => {
    expect(parseTags('<task-status>wat</task-status>')).toEqual([]);
  });

  it('parses <blocker>', () => {
    expect(parseTags('<blocker>cannot find file</blocker>')).toEqual([
      { kind: 'blocker', reason: 'cannot find file' },
    ]);
  });

  it('parses <review-request agents="a,b"/>', () => {
    expect(parseTags('<review-request agents="a,b"/>')).toEqual([
      { kind: 'review-request', agents: ['a', 'b'] },
    ]);
  });

  it('parses <audit-verdict>', () => {
    expect(parseTags('<audit-verdict agent="x" status="GO">looks good</audit-verdict>')).toEqual([
      { kind: 'audit-verdict', agent: 'x', status: 'GO', text: 'looks good' },
    ]);
  });

  it('rejects audit-verdict with unknown status', () => {
    expect(parseTags('<audit-verdict agent="x" status="MEH">x</audit-verdict>')).toEqual([]);
  });
});
