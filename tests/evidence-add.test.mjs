import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { evidenceAdd } from '../engine/evidence-add.mjs';
import { saveState, saveTree, loadState, loadTree } from '../engine/state.mjs';
import { activeDir } from '../engine/paths.mjs';

const tmpRoots = [];
afterEach(() => {
  for (const r of tmpRoots) {
    try { fs.rmSync(r, { recursive: true, force: true }); } catch {}
  }
  tmpRoots.length = 0;
});

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-evadd-'));
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
        acceptance_criteria: ['c0', 'c1'],
        review: [], validate: null, work_front: null, status: 'pursuing',
        evidence: [], blocker_reason: null, review_attempts: 0, notes: [], children: [],
      }],
    },
  });
  saveState(root, {
    schema_version: 2, goal_id: 'g', lifecycle: 'pursuing', cursor: 't',
    budget: {
      iterations: { used: 1, max: 100 },
      tokens: { used: 0, max: 0 },
      wallclock: { started_at: new Date().toISOString(), max_seconds: 86400 },
    },
    session_id: 's', started_at: new Date().toISOString(),
    paused_at: null, ended_at: null, ended_reason: null,
    history: [], consecutive_silent_turns: 0,
  });
  return root;
}

describe('evidenceAdd', () => {
  it('adds file-based evidence and increments evidence_count', () => {
    const root = setup();
    const r = evidenceAdd(root, {
      criterion: 0, file: 'src/foo.ts', line: 42, note: 'proof',
    });
    expect(r.ok).toBe(true);
    expect(r.evidence_count).toBe(1);
    const tree = loadTree(root);
    const t = tree.root.children[0];
    expect(t.evidence).toHaveLength(1);
    expect(t.evidence[0].file).toBe('src/foo.ts');
    expect(t.evidence[0].criterion_index).toBe(0);
  });

  it('rejects when lifecycle !== pursuing', () => {
    const root = setup();
    const st = loadState(root);
    st.lifecycle = 'paused';
    saveState(root, st);
    const r = evidenceAdd(root, { criterion: 0, file: 'f', note: '' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/lifecycle/);
  });

  it('rejects when state.json is missing (no active goal)', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-evadd-nostate-'));
    tmpRoots.push(root);
    const r = evidenceAdd(root, { criterion: 0, file: 'f', note: '' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no active goal/i);
  });

  it('rejects when tree.json is missing', () => {
    const root = setup();
    const treePath = path.join(activeDir(root), 'tree.json');
    fs.rmSync(treePath, { force: true });
    const r = evidenceAdd(root, { criterion: 0, file: 'f', note: '' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/tree/i);
  });

  it('rejects when cursor is not in tree', () => {
    const root = setup();
    const st = loadState(root);
    st.cursor = 'nonexistent-id';
    saveState(root, st);
    const r = evidenceAdd(root, { criterion: 0, file: 'f', note: '' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/cursor/i);
    expect(r.error).toMatch(/not.*tree/i);
  });

  it('rejects when cursor.status is achieved', () => {
    const root = setup();
    const tree = loadTree(root);
    tree.root.children[0].status = 'achieved';
    saveTree(root, tree);
    const r = evidenceAdd(root, { criterion: 0, file: 'f', note: '' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/pursuing or review-pending/i);
    expect(r.error).toMatch(/achieved/);
  });
});
