import { describe, it, expect } from 'vitest';
import { render, TemplateRenderError } from '../engine/continuation.mjs';
import { readFileSync } from 'node:fs';
import path from 'node:path';

describe('render', () => {
  it('replaces {{var}} with value', () => {
    expect(render('hi {{name}}', { name: 'Andres' })).toBe('hi Andres');
  });

  it('handles missing values as empty string', () => {
    expect(render('hi {{name}}', {})).toBe('hi ');
  });

  it('expands {{#each list}}{{this}}{{/each}}', () => {
    const tpl = '{{#each items}}- {{this}}\n{{/each}}';
    expect(render(tpl, { items: ['a', 'b'] })).toBe('- a\n- b\n');
  });

  it('expands {{#each list}}{{prop}}{{/each}} on objects', () => {
    const tpl = '{{#each items}}{{name}};{{/each}}';
    expect(render(tpl, { items: [{ name: 'x' }, { name: 'y' }] })).toBe('x;y;');
  });

  it('handles {{#if cond}}…{{/if}} truthy', () => {
    const tpl = '{{#if shown}}HI{{/if}}';
    expect(render(tpl, { shown: true })).toBe('HI');
    expect(render(tpl, { shown: false })).toBe('');
    expect(render(tpl, {})).toBe('');
  });

  it('escapes nothing — output is raw, since these are LLM prompts not HTML', () => {
    expect(render('{{x}}', { x: '<tag>' })).toBe('<tag>');
  });

  it('renders 0 as "0"', () => {
    expect(render('{{x}}', { x: 0 })).toBe('0');
  });

  it('renders false as "false"', () => {
    expect(render('{{x}}', { x: false })).toBe('false');
  });

  it('renders empty string as ""', () => {
    expect(render('{{x}}', { x: '' })).toBe('');
  });

  it('treats {{#if}} on empty array as falsy', () => {
    expect(render('{{#if xs}}Y{{/if}}', { xs: [] })).toBe('');
  });

  it('treats {{#if}} on non-empty array as truthy', () => {
    expect(render('{{#if xs}}Y{{/if}}', { xs: [1] })).toBe('Y');
  });

  it('treats {{#each}} over a non-array as empty', () => {
    expect(render('{{#each xs}}-{{/each}}', { xs: 'oops' })).toBe('');
  });

  it('resolves dotted-path access', () => {
    expect(render('hi {{user.name}}', { user: { name: 'Alex' } })).toBe('hi Alex');
  });

  it('resolves dotted-path through nullish gracefully', () => {
    expect(render('hi {{user.name}}', {})).toBe('hi ');
  });

  it('throws on unbalanced opening directive', () => {
    expect(() => render('{{#each xs}}body', { xs: [1] })).toThrow(/unclosed|unbalanced|unmatched|malformed/i);
  });

  it('throws on orphan closing directive', () => {
    expect(() => render('done {{/each}}', {})).toThrow(/unmatched|unbalanced|malformed/i);
  });

  it('passes user data containing literal {{x}} text through to output', () => {
    expect(render('{{note}}', { note: 'see {{user.name}}' })).toBe('see {{user.name}}');
  });

  it('passes user data with mustache-like text through {{#each}}', () => {
    const tpl = '{{#each items}}- {{text}}\n{{/each}}';
    const ctx = { items: [{ text: 'docs say {{var}} works' }, { text: '{{#each}} too' }] };
    expect(render(tpl, ctx)).toBe('- docs say {{var}} works\n- {{#each}} too\n');
  });

  it('throws TemplateRenderError on whitespace inside braces', () => {
    expect(() => render('hi {{ name }}', { name: 'x' })).toThrow(TemplateRenderError);
  });

  it('throws TemplateRenderError on empty braces', () => {
    expect(() => render('{{}}', {})).toThrow(TemplateRenderError);
  });

  it('throws TemplateRenderError on hyphen in directive (unsupported char)', () => {
    expect(() => render('{{a-b}}', {})).toThrow(TemplateRenderError);
  });

  it('throws TemplateRenderError on if/each kind mismatch', () => {
    expect(() => render('{{#each xs}}body{{/if}}', { xs: [1] })).toThrow(TemplateRenderError);
  });

  it('TemplateRenderError carries token and position metadata', () => {
    try {
      render('{{#each xs}}body', { xs: [1] });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(TemplateRenderError);
      expect(err.token).toBe('{{#each xs}}');
      expect(typeof err.position).toBe('number');
    }
  });

  it('expands nested {{#if}} correctly', () => {
    const tpl = '{{#if a}}A{{#if b}}-B{{/if}}{{/if}}';
    expect(render(tpl, { a: true, b: true })).toBe('A-B');
    expect(render(tpl, { a: true, b: false })).toBe('A');
    expect(render(tpl, { a: false, b: true })).toBe('');
  });

  it('expands nested {{#each}} correctly', () => {
    const tpl = '{{#each rows}}{{#each cells}}[{{this}}]{{/each}}\n{{/each}}';
    const ctx = { rows: [{ cells: ['a', 'b'] }, { cells: ['c'] }] };
    expect(render(tpl, ctx)).toBe('[a][b]\n[c]\n');
  });

  it('expands {{#if}} inside {{#each}} resolving against per-item context', () => {
    const tpl = '{{#each items}}{{name}}{{#if active}}*{{/if}};{{/each}}';
    const ctx = { items: [{ name: 'x', active: true }, { name: 'y', active: false }] };
    expect(render(tpl, ctx)).toBe('x*;y;');
  });
});

describe('continuation.md snapshot render', () => {
  it('renders against a representative state', () => {
    const tpl = readFileSync(path.join(import.meta.dirname, '../prompts/continuation.md'), 'utf8');
    const ctx = {
      iteration: 7,
      iterations_max: 100,
      sprint_title: 'Sprint 1: Auth',
      epic_title: 'Epic 1.1: Token refresh',
      task_title: 'Implement RT-rotation',
      task_id: 's1.e1.t1',
      work_front: 'engine',
      task_goal: 'Rotate refresh token on every use.',
      criteria: [
        { index: 0, text: 'Old token rejected', covered_marker: 'x' },
        { index: 1, text: 'New token issued', covered_marker: ' ' },
      ],
      evidence: [
        { iteration: 6, criterion_index: 0, note: 'rejected at line 42', file: 'src/auth.ts', line: 42, command: null, exit_code: null },
      ],
      has_review: true,
      review_agents_csv: 'aaa-art-director,rpg-game-designer',
      has_validate: true,
      validate: 'npm test -- src/auth',
      tokens_used: 12345,
      tokens_max: 2000000,
      wallclock_minutes: 22,
      wallclock_max_minutes: 240,
    };
    const out = render(tpl, ctx);
    expect(out).toMatchSnapshot();
  });
});

describe('continuation-review.md snapshot', () => {
  it('renders with reviewer list and audit body', () => {
    const tpl = readFileSync(path.join(import.meta.dirname, '../prompts/continuation-review.md'), 'utf8');
    const ctx = {
      task_title: 'Implement RT-rotation',
      task_id: 's1.e1.t1',
      review_agents_csv: 'aaa-art-director,rpg-game-designer',
      audit_instructions: '(audit body placeholder for snapshot)',
    };
    expect(render(tpl, ctx)).toMatchSnapshot();
  });
});

describe('continuation-blocked.md snapshot', () => {
  it('renders with verdicts and uncovered criteria', () => {
    const tpl = readFileSync(path.join(import.meta.dirname, '../prompts/continuation-blocked.md'), 'utf8');
    const ctx = {
      review_attempts: 2,
      task_title: 'Implement RT-rotation',
      task_id: 's1.e1.t1',
      blocker_reason: 'Token signing key rotation untested under load',
      last_verdicts: [
        { agent: 'aaa-art-director', status: 'NOGO', text: 'No load-test evidence for criterion #1' },
        { agent: 'rpg-game-designer', status: 'REVISE', text: 'Revoke flow needs second integration test' },
      ],
      uncovered_criteria: [
        { index: 1, text: 'New token issued' },
      ],
    };
    expect(render(tpl, ctx)).toMatchSnapshot();
  });
});

describe('budget-limit.md snapshot', () => {
  it('renders the budget-exhausted graceful exit prompt', () => {
    const tpl = readFileSync(path.join(import.meta.dirname, '../prompts/budget-limit.md'), 'utf8');
    const ctx = {
      limit_kind: 'iterations',
      iterations_used: 100,
      iterations_max: 100,
      tokens_used: 1850000,
      tokens_max: 2000000,
      wallclock_minutes: 215,
      wallclock_max_minutes: 240,
      ts: '2026-05-09T22:00:00Z',
    };
    expect(render(tpl, ctx)).toMatchSnapshot();
  });
});

describe('final-summary.md snapshot', () => {
  it('renders the goal-achieved summary prompt', () => {
    const tpl = readFileSync(path.join(import.meta.dirname, '../prompts/final-summary.md'), 'utf8');
    const ctx = {
      iterations_used: 73,
      ts: '2026-05-09T23:30:00Z',
      sprint_count: 3,
      epic_count: 8,
      task_count: 24,
      tokens_used: 1340000,
      wallclock_minutes: 188,
      audit_count: 12,
    };
    expect(render(tpl, ctx)).toMatchSnapshot();
  });
});

describe('unmet-summary.md snapshot render', () => {
  it('renders against a representative unmet-state', () => {
    const tpl = readFileSync(path.join(import.meta.dirname, '../prompts/unmet-summary.md'), 'utf8');
    const ctx = {
      blocked_task_id: 's.e1.t1',
      blocked_task_title: 'Implement RT-rotation',
      blocker_reason: '3 consecutive review cycles ended in NOGO/REVISE',
      review_attempts: 3,
      iterations_used: 47,
      tokens_used: 980000,
      wallclock_minutes: 142,
      tasks_achieved: 0,
      tasks_total: 1,
      ts: '2026-05-10T01:30:00Z',
    };
    const out = render(tpl, ctx);
    expect(out).toMatchSnapshot();
  });
});

describe('audit-instructions.md snapshot', () => {
  it('renders with criteria, evidence (with nested file/line), and validate', () => {
    const tpl = readFileSync(path.join(import.meta.dirname, '../prompts/audit-instructions.md'), 'utf8');
    const ctx = {
      task_id: 's1.e1.t1',
      task_title: 'Implement RT-rotation',
      task_goal: 'Rotate refresh token on every use.',
      criteria: [
        { index: 0, text: 'Old token rejected' },
        { index: 1, text: 'New token issued' },
      ],
      evidence: [
        { iteration: 6, criterion_index: 0, note: 'rejected at line 42', file: 'src/auth.ts', line: 42, command: null, exit_code: null },
        { iteration: 6, criterion_index: 1, note: 'green', file: null, line: null, command: 'npm test -- src/auth', exit_code: 0 },
      ],
      validate: 'npm test -- src/auth',
    };
    expect(render(tpl, ctx)).toMatchSnapshot();
  });
});

import { buildContext } from '../engine/continuation.mjs';

describe('buildContext', () => {
  it('builds the full context object for a pursuing turn', () => {
    const tree = {
      root: {
        id: 's', type: 'sprint', title: 'Sprint 1', goal: '', acceptance_criteria: [],
        review: [], validate: null, work_front: 'engine', status: 'pursuing',
        evidence: [], blocker_reason: null, review_attempts: 0, notes: [],
        children: [
          { id: 's.e1', type: 'epic', title: 'Epic 1.1', goal: '', acceptance_criteria: [], review: [], validate: null, work_front: 'engine', status: 'pursuing', evidence: [], blocker_reason: null, review_attempts: 0, notes: [], children: [
            { id: 's.e1.t1', type: 'task', title: 'T1', goal: 'Do thing.', acceptance_criteria: ['c0', 'c1'], review: ['agent-a'], validate: 'npm test', work_front: 'engine', status: 'pursuing', evidence: [
              { ts: 't', iteration: 1, criterion_index: 0, file: 'x', line: null, commit: null, command: null, exit_code: null, note: 'covers c0' },
            ], blocker_reason: null, review_attempts: 0, notes: [], children: [] },
          ] },
        ],
      },
    };
    const state = {
      budget: { iterations: { used: 7, max: 100 }, tokens: { used: 1000, max: 1000000 }, wallclock: { started_at: new Date(Date.now() - 60_000).toISOString(), max_seconds: 14400 } },
    };
    const ctx = buildContext(tree, state, 's.e1.t1');
    expect(ctx.task_id).toBe('s.e1.t1');
    expect(ctx.sprint_title).toBe('Sprint 1');
    expect(ctx.epic_title).toBe('Epic 1.1');
    expect(ctx.criteria.length).toBe(2);
    expect(ctx.criteria[0].covered_marker).toBe('x');
    expect(ctx.criteria[1].covered_marker).toBe(' ');
    expect(ctx.has_review).toBe(true);
    expect(ctx.has_validate).toBe(true);
    expect(ctx.review_agents_csv).toBe('agent-a');
  });
});

describe('buildContext hardening', () => {
  function singleTaskTree(criteria = ['c0'], evidence = []) {
    return {
      root: {
        id: 't', type: 'task', title: 'T', goal: 'G', acceptance_criteria: criteria,
        review: [], validate: null, work_front: null, status: 'pursuing',
        evidence, blocker_reason: null, review_attempts: 0, notes: [], children: [],
      },
    };
  }

  function freshState(startedAtIso = '2026-05-09T22:00:00.000Z') {
    return {
      budget: {
        iterations: { used: 1, max: 100 },
        tokens: { used: 0, max: 1_000_000 },
        wallclock: { started_at: startedAtIso, max_seconds: 14400 },
      },
    };
  }

  it('returns null when cursorId does not match any node', () => {
    const tree = singleTaskTree();
    const state = freshState();
    expect(buildContext(tree, state, 'nonexistent')).toBeNull();
  });

  it('marks all criteria uncovered when evidence is empty', () => {
    const tree = singleTaskTree(['c0', 'c1', 'c2'], []);
    const state = freshState();
    const ctx = buildContext(tree, state, 't');
    expect(ctx.criteria.every(c => c.covered_marker === ' ')).toBe(true);
  });

  it('marks all criteria covered when evidence covers each', () => {
    const tree = singleTaskTree(['c0', 'c1'], [
      { ts: 't', iteration: 1, criterion_index: 0, file: 'a', line: null, commit: null, command: null, exit_code: null, note: 'a' },
      { ts: 't', iteration: 1, criterion_index: 1, file: 'b', line: null, commit: null, command: null, exit_code: null, note: 'b' },
    ]);
    const state = freshState();
    const ctx = buildContext(tree, state, 't');
    expect(ctx.criteria.every(c => c.covered_marker === 'x')).toBe(true);
  });

  it('exposes has_review=false and empty review_agents_csv when review[] is empty', () => {
    const tree = singleTaskTree();
    const state = freshState();
    const ctx = buildContext(tree, state, 't');
    expect(ctx.has_review).toBe(false);
    expect(ctx.review_agents_csv).toBe('');
  });

  it('exposes has_validate=false and empty validate when task.validate is null', () => {
    const tree = singleTaskTree();
    const state = freshState();
    const ctx = buildContext(tree, state, 't');
    expect(ctx.has_validate).toBe(false);
    expect(ctx.validate).toBe('');
  });

  it('returns sprint_title="" and epic_title="" for a task at the root (no ancestors)', () => {
    const tree = singleTaskTree();
    const state = freshState();
    const ctx = buildContext(tree, state, 't');
    expect(ctx.sprint_title).toBe('');
    expect(ctx.epic_title).toBe('');
  });

  it('produces deterministic wallclock_minutes when now is injected (I1)', () => {
    const tree = singleTaskTree();
    const state = freshState('2026-05-09T22:00:00.000Z');
    const now = new Date('2026-05-09T22:30:00.000Z').getTime();
    const ctx = buildContext(tree, state, 't', now);
    expect(ctx.wallclock_minutes).toBe(30);
  });

  it('clamps wallclock_minutes to 0 on clock skew with started_at in the future (I2)', () => {
    const tree = singleTaskTree();
    const state = freshState('2026-05-09T23:00:00.000Z');
    const now = new Date('2026-05-09T22:30:00.000Z').getTime();
    const ctx = buildContext(tree, state, 't', now);
    expect(ctx.wallclock_minutes).toBe(0);
  });
});
