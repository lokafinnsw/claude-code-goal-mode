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

describe('parseTags hardening fix-ups', () => {
  // I1: empty criterion should skip
  it('skips evidence with empty criterion attr (I1)', () => {
    expect(parseTags('<evidence file="x" criterion="" />')).toEqual([]);
  });

  // I2: > inside double-quoted attr values
  it('parses evidence with > inside double-quoted note (I2)', () => {
    const out = parseTags('<evidence criterion="0" note="size > 5" />');
    expect(out.length).toBe(1);
    expect(out[0].note).toBe('size > 5');
  });

  it('parses audit-verdict with > inside body (regression lock)', () => {
    const out = parseTags('<audit-verdict agent="x" status="GO">a > b matters</audit-verdict>');
    expect(out).toEqual([{ kind: 'audit-verdict', agent: 'x', status: 'GO', text: 'a > b matters' }]);
  });

  // I3: empty blocker should skip
  it('skips empty <blocker></blocker> (I3)', () => {
    expect(parseTags('<blocker></blocker>')).toEqual([]);
  });

  it('skips whitespace-only <blocker> (I3)', () => {
    expect(parseTags('<blocker>   \n  </blocker>')).toEqual([]);
  });

  // M1: single-quoted attrs supported
  it('accepts single-quoted attribute values', () => {
    const out = parseTags("<evidence criterion='0' file='x.ts' note='single' />");
    expect(out.length).toBe(1);
    expect(out[0]).toMatchObject({ criterion: 0, file: 'x.ts', note: 'single' });
  });

  // M3: duplicate attrs last-wins
  it('duplicate attribute name uses last-wins', () => {
    const out = parseTags('<evidence criterion="0" criterion="1" file="x" />');
    expect(out[0].criterion).toBe(1);
  });

  // M5: multiple task-status all emitted
  it('emits all <task-status> tags in source order', () => {
    const out = parseTags('<task-status>pursuing</task-status> mid <task-status>achieved</task-status>');
    expect(out).toEqual([
      { kind: 'task-status', value: 'pursuing' },
      { kind: 'task-status', value: 'achieved' },
    ]);
  });

  // M7: paired review-request unsupported (self-closed only)
  it('skips paired <review-request agents="x"></review-request> (self-closed only)', () => {
    expect(parseTags('<review-request agents="x"></review-request>')).toEqual([]);
  });

  // No-attrs evidence still skipped (already correct, pin it)
  it('skips <evidence>body</evidence> with no criterion attr', () => {
    expect(parseTags('<evidence>body</evidence>')).toEqual([]);
  });

  // Empty agents="" review-request still skipped (pin it)
  it('skips <review-request agents="" />', () => {
    expect(parseTags('<review-request agents="" />')).toEqual([]);
  });

  // Code-fenced example tags ARE parsed (documented non-feature)
  it('parses tags inside markdown code fences (no Markdown awareness)', () => {
    const text = "```xml\n<evidence file=\"x\" criterion=\"0\" note=\"example\" />\n```";
    const out = parseTags(text);
    expect(out.length).toBe(1);
    expect(out[0].file).toBe('x');
  });

  // Mixed-tag integration smoke test
  it('parses one of each kind in a single text', () => {
    const text = [
      '<evidence file="a" criterion="0" note="n" />',
      '<task-status>achieved</task-status>',
      '<review-request agents="r1,r2" />',
      '<audit-verdict agent="r1" status="GO">ok</audit-verdict>',
      '<blocker>oops</blocker>',
    ].join(' ');
    const out = parseTags(text);
    const kinds = out.map(t => t.kind);
    expect(kinds).toEqual(['evidence', 'task-status', 'blocker', 'review-request', 'audit-verdict']);
  });
});
