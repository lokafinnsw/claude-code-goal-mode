import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { saveState, saveTree, loadState } from '../engine/state.mjs';
import { activeDir } from '../engine/paths.mjs';
import { extendBudget } from '../engine/goal-extend.mjs';
import { parseTokens, parseIter, parseTime } from '../engine/goal-extend-cli.mjs';

const CLI = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', 'engine', 'goal-extend-cli.mjs',
);

const tmpRoots = [];
afterEach(() => {
  for (const r of tmpRoots) {
    try { fs.rmSync(r, { recursive: true, force: true }); } catch {}
  }
  tmpRoots.length = 0;
});

function setup({
  lifecycle = 'pursuing',
  tokensMax = 60_000_000,
  tokensUsed = 50_000_000,
  iterMax = 1000,
  iterUsed = 500,
  wallMax = 86_400,
  endedAt = null,
  endedReason = null,
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-extend-'));
  tmpRoots.push(root);
  fs.mkdirSync(activeDir(root), { recursive: true });
  saveTree(root, {
    schema_version: 2, goal_id: 'g', mission: 'm',
    created_at: '2026-05-12T00:00:00.000Z',
    approved_at: '2026-05-12T00:00:00.000Z',
    root: {
      id: 's', type: 'sprint', title: 'S', goal: 'g', acceptance_criteria: [],
      review: [], validate: null, work_front: null, status: 'pursuing',
      evidence: [], blocker_reason: null, review_attempts: 0, notes: [],
      children: [{
        id: 't', type: 'task', title: 't', goal: 'tg',
        acceptance_criteria: ['c0'],
        review: [], validate: null, work_front: null, status: 'pursuing',
        evidence: [], blocker_reason: null, review_attempts: 0, notes: [], children: [],
      }],
    },
  });
  saveState(root, {
    schema_version: 2, goal_id: 'g', lifecycle, cursor: 't',
    budget: {
      iterations: { used: iterUsed, max: iterMax },
      tokens: { used: tokensUsed, max: tokensMax },
      wallclock: { started_at: new Date().toISOString(), max_seconds: wallMax },
    },
    session_id: 's', started_at: new Date().toISOString(),
    paused_at: null, ended_at: endedAt, ended_reason: endedReason,
    history: [], consecutive_silent_turns: 0,
  });
  return root;
}

describe('parseTokens', () => {
  it('parses bare integer as absolute seconds-of-token (no-suffix)', () => {
    expect(parseTokens('60000000')).toEqual({ mode: 'absolute', value: 60_000_000 });
  });
  it('parses +N as delta', () => {
    expect(parseTokens('+50000000')).toEqual({ mode: 'delta', value: 50_000_000 });
  });
  it('parses k suffix', () => {
    expect(parseTokens('50k')).toEqual({ mode: 'absolute', value: 50_000 });
  });
  it('parses m suffix (case-insensitive)', () => {
    expect(parseTokens('50M')).toEqual({ mode: 'absolute', value: 50_000_000 });
    expect(parseTokens('+50m')).toEqual({ mode: 'delta', value: 50_000_000 });
  });
  it('throws on bad input', () => {
    expect(() => parseTokens('abc')).toThrow(/bad --tokens/);
    expect(() => parseTokens('50g')).toThrow(/bad --tokens/);
    expect(() => parseTokens('-50M')).toThrow(/bad --tokens/);
  });
});

describe('parseIter', () => {
  it('parses bare integer as absolute', () => {
    expect(parseIter('5000')).toEqual({ mode: 'absolute', value: 5000 });
  });
  it('parses +N as delta', () => {
    expect(parseIter('+1000')).toEqual({ mode: 'delta', value: 1000 });
  });
  it('throws on suffix', () => {
    expect(() => parseIter('1000k')).toThrow(/bad --iter/);
    expect(() => parseIter('abc')).toThrow(/bad --iter/);
  });
});

describe('parseTime', () => {
  it('parses h suffix', () => {
    expect(parseTime('4h')).toEqual({ mode: 'absolute', value: 14_400 });
    expect(parseTime('+8h')).toEqual({ mode: 'delta', value: 28_800 });
  });
  it('parses m suffix (minutes)', () => {
    expect(parseTime('30m')).toEqual({ mode: 'absolute', value: 1800 });
    expect(parseTime('+30m')).toEqual({ mode: 'delta', value: 1800 });
  });
  it('parses d suffix (days)', () => {
    expect(parseTime('2d')).toEqual({ mode: 'absolute', value: 172_800 });
  });
  it('parses s suffix or bare as seconds', () => {
    expect(parseTime('3600')).toEqual({ mode: 'absolute', value: 3600 });
    expect(parseTime('+3600s')).toEqual({ mode: 'delta', value: 3600 });
  });
  it('throws on bad input', () => {
    expect(() => parseTime('4y')).toThrow(/bad --time/);
    expect(() => parseTime('abc')).toThrow(/bad --time/);
  });
});

describe('extendBudget — delta mode', () => {
  it('bumps tokens by +50M from max=60M', () => {
    const root = setup();
    const r = extendBudget(root, { tokens: { mode: 'delta', value: 50_000_000 } });
    expect(r.ok).toBe(true);
    expect(r.old.tokens).toBe(60_000_000);
    expect(r.new.tokens).toBe(110_000_000);
    const st = loadState(root);
    expect(st.budget.tokens.max).toBe(110_000_000);
    expect(st.budget.iterations.max).toBe(1000); // untouched
  });

  it('bumps iter by +1000 from max=1000', () => {
    const root = setup();
    const r = extendBudget(root, { iter: { mode: 'delta', value: 1000 } });
    expect(r.ok).toBe(true);
    expect(r.new.iter).toBe(2000);
  });

  it('bumps wallclock by +4h', () => {
    const root = setup();
    const r = extendBudget(root, { time: { mode: 'delta', value: 14_400 } });
    expect(r.ok).toBe(true);
    expect(r.new.time_seconds).toBe(86_400 + 14_400);
  });
});

describe('extendBudget — absolute mode', () => {
  it('replaces tokens max with 150M', () => {
    const root = setup();
    const r = extendBudget(root, { tokens: { mode: 'absolute', value: 150_000_000 } });
    expect(r.ok).toBe(true);
    expect(r.new.tokens).toBe(150_000_000);
  });

  it('multiple dimensions at once', () => {
    const root = setup();
    const r = extendBudget(root, {
      tokens: { mode: 'delta', value: 50_000_000 },
      iter:   { mode: 'delta', value: 500 },
      time:   { mode: 'delta', value: 7200 },
    });
    expect(r.ok).toBe(true);
    expect(r.new.tokens).toBe(110_000_000);
    expect(r.new.iter).toBe(1500);
    expect(r.new.time_seconds).toBe(93_600);
  });
});

describe('extendBudget — lifecycle transitions', () => {
  it('budget-limited → pursuing on bump (clears ended_at/ended_reason)', () => {
    const root = setup({
      lifecycle: 'budget-limited',
      endedAt: '2026-05-12T01:00:00.000Z',
      endedReason: 'tokens budget exhausted',
    });
    const r = extendBudget(root, { tokens: { mode: 'delta', value: 50_000_000 } });
    expect(r.ok).toBe(true);
    expect(r.lifecycle_transition).toEqual({ from: 'budget-limited', to: 'pursuing' });
    const st = loadState(root);
    expect(st.lifecycle).toBe('pursuing');
    expect(st.ended_at).toBe(null);
    expect(st.ended_reason).toBe(null);
  });

  it('pursuing → pursuing (no transition, just bump)', () => {
    const root = setup({ lifecycle: 'pursuing' });
    const r = extendBudget(root, { iter: { mode: 'delta', value: 500 } });
    expect(r.ok).toBe(true);
    expect(r.lifecycle_transition).toBe(null);
    const st = loadState(root);
    expect(st.lifecycle).toBe('pursuing');
  });
});

describe('extendBudget — preconditions', () => {
  it('rejects when lifecycle is paused', () => {
    const root = setup({ lifecycle: 'paused' });
    const r = extendBudget(root, { tokens: { mode: 'delta', value: 50_000_000 } });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/cannot extend budget from lifecycle=paused/);
  });

  it('rejects when lifecycle is achieved', () => {
    const root = setup({ lifecycle: 'achieved' });
    const r = extendBudget(root, { iter: { mode: 'delta', value: 100 } });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/lifecycle=achieved/);
  });

  it('rejects when no opts provided', () => {
    const root = setup();
    const r = extendBudget(root, {});
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/at least one of/);
  });

  it('rejects when no active goal', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-extend-nogoal-'));
    tmpRoots.push(root);
    fs.mkdirSync(activeDir(root), { recursive: true });
    const r = extendBudget(root, { tokens: { mode: 'delta', value: 50_000_000 } });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/No active goal/);
  });

  it('rejects when new tokens max < used', () => {
    const root = setup({ tokensMax: 60_000_000, tokensUsed: 50_000_000 });
    const r = extendBudget(root, { tokens: { mode: 'absolute', value: 10_000_000 } });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/tokens max \(10000000\) < used \(50000000\)/);
  });

  it('rejects when new iter max < used', () => {
    const root = setup({ iterMax: 1000, iterUsed: 500 });
    const r = extendBudget(root, { iter: { mode: 'absolute', value: 100 } });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/iter max \(100\) < used \(500\)/);
  });
});

describe('extendBudget — history event', () => {
  it("appends 'budget-extended' history event with correct payload", () => {
    const root = setup({
      lifecycle: 'budget-limited',
      endedAt: '2026-05-12T01:00:00.000Z',
      endedReason: 'tokens budget exhausted',
    });
    extendBudget(root, {
      tokens: { mode: 'delta', value: 50_000_000 },
      iter:   { mode: 'delta', value: 100 },
    });
    const st = loadState(root);
    const ev = st.history.find(e => e.event === 'budget-extended');
    expect(ev).toBeTruthy();
    expect(ev.payload.old.tokens).toBe(60_000_000);
    expect(ev.payload.new.tokens).toBe(110_000_000);
    expect(ev.payload.old.iter).toBe(1000);
    expect(ev.payload.new.iter).toBe(1100);
    expect(ev.payload.transition).toEqual({ from: 'budget-limited', to: 'pursuing' });
    expect(ev.node_id).toBe('t');
  });
});

describe('goal-extend-cli', () => {
  it('exits 0 with --tokens +50M', () => {
    const root = setup();
    const r = spawnSync('node', [CLI, '--tokens', '+50M'], { cwd: root });
    expect(r.status).toBe(0);
    expect(r.stdout.toString()).toMatch(/tokens: 60\.0M → 110\.0M/);
  });

  it('exits 0 with combined flags + reports lifecycle transition', () => {
    const root = setup({
      lifecycle: 'budget-limited',
      endedAt: '2026-05-12T01:00:00.000Z',
      endedReason: 'tokens budget exhausted',
    });
    const r = spawnSync('node', [CLI, '--tokens', '+50M', '--time', '+4h'], { cwd: root });
    expect(r.status).toBe(0);
    const out = r.stdout.toString();
    expect(out).toMatch(/tokens:/);
    expect(out).toMatch(/time:/);
    expect(out).toMatch(/lifecycle: budget-limited → pursuing/);
  });

  it('exits 2 on bad --tokens value', () => {
    const root = setup();
    const r = spawnSync('node', [CLI, '--tokens', '50g'], { cwd: root });
    expect(r.status).toBe(2);
    expect(r.stderr.toString()).toMatch(/bad --tokens/);
  });

  it('exits 2 on unknown arg', () => {
    const root = setup();
    const r = spawnSync('node', [CLI, '--bogus', 'x'], { cwd: root });
    expect(r.status).toBe(2);
    expect(r.stderr.toString()).toMatch(/Unknown arg/);
  });

  it('exits 1 on lifecycle precondition fail', () => {
    const root = setup({ lifecycle: 'paused' });
    const r = spawnSync('node', [CLI, '--tokens', '+50M'], { cwd: root });
    expect(r.status).toBe(1);
    expect(r.stderr.toString()).toMatch(/lifecycle=paused/);
  });

  it('exits 1 when no args (precondition: at least one dim)', () => {
    const root = setup();
    const r = spawnSync('node', [CLI], { cwd: root });
    expect(r.status).toBe(1);
    expect(r.stderr.toString()).toMatch(/at least one of/);
  });
});
