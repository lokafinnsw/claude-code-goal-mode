import { describe, it, expect } from 'vitest';
import { renderStatusReport } from '../engine/render-status-cli.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { saveTree, saveState } from '../engine/state.mjs';

const sampleTree = () => ({
  schema_version: 1,
  goal_id: 'g',
  mission: 'm',
  created_at: '2026-05-09T00:00:00.000Z',
  approved_at: '2026-05-09T00:00:00.000Z',
  root: {
    id: 't', type: 'task', title: 'T', goal: 'G',
    acceptance_criteria: ['c0'], review: [], validate: null,
    work_front: null, status: 'pursuing',
    evidence: [], blocker_reason: null, review_attempts: 0, notes: [],
    children: [],
  },
});

const samplePursuingState = () => ({
  schema_version: 1,
  goal_id: 'g',
  lifecycle: 'pursuing',
  cursor: 't',
  budget: {
    iterations: { used: 1, max: 100 },
    tokens: { used: 0, max: 1_000_000 },
    wallclock: { started_at: new Date().toISOString(), max_seconds: 14400 },
  },
  session_id: 'sess-1',
  started_at: new Date().toISOString(),
  paused_at: null, ended_at: null, ended_reason: null,
  history: [],
});

describe('renderStatusReport', () => {
  it('renders status output when active goal exists', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rsr-'));
    saveTree(root, sampleTree());
    saveState(root, samplePursuingState());
    const result = renderStatusReport(root);
    expect(result.exit).toBe(0);
    expect(result.output).toContain('lifecycle: pursuing');
    expect(result.output).toContain('t ◀ cursor');
  });

  it('returns no-active-goal message when state and tree are missing AND no archives', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rsr-empty-'));
    const result = renderStatusReport(root);
    expect(result.exit).toBe(0);
    expect(result.output).toBe('No active goal. Run /goal:plan to start.');
  });

  it('mentions archived goals count when no active goal but archives exist (singular)', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rsr-archive1-'));
    const archDir = path.join(root, '.claude', 'goals', 'archive');
    fs.mkdirSync(path.join(archDir, '2026-05-09T20-00-00-000Z-prior-goal'), { recursive: true });
    const result = renderStatusReport(root);
    expect(result.exit).toBe(0);
    expect(result.output).toMatch(/1 archived goal/);
    expect(result.output).not.toMatch(/1 archived goals/);  // singular form
    expect(result.output).toContain('.claude/goals/archive');
  });

  it('mentions archived goals count when no active goal but archives exist (plural)', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rsr-archive2-'));
    const archDir = path.join(root, '.claude', 'goals', 'archive');
    fs.mkdirSync(path.join(archDir, '2026-05-09T20-00-00-000Z-goal-a'), { recursive: true });
    fs.mkdirSync(path.join(archDir, '2026-05-09T21-00-00-000Z-goal-b'), { recursive: true });
    fs.mkdirSync(path.join(archDir, '2026-05-09T22-00-00-000Z-goal-c'), { recursive: true });
    const result = renderStatusReport(root);
    expect(result.exit).toBe(0);
    expect(result.output).toMatch(/3 archived goals/);
  });

  it('ignores files in archive dir, only counts subdirectories', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rsr-archive-mixed-'));
    const archDir = path.join(root, '.claude', 'goals', 'archive');
    fs.mkdirSync(archDir, { recursive: true });
    fs.mkdirSync(path.join(archDir, 'real-archive-dir'));
    fs.writeFileSync(path.join(archDir, 'stray-file.txt'), 'noise');
    const result = renderStatusReport(root);
    expect(result.exit).toBe(0);
    expect(result.output).toMatch(/1 archived goal/);
  });

  it('prefers active goal output over archive fallback when both exist', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rsr-both-'));
    saveTree(root, sampleTree());
    saveState(root, samplePursuingState());
    fs.mkdirSync(path.join(root, '.claude', 'goals', 'archive', 'old-archive'), { recursive: true });
    const result = renderStatusReport(root);
    expect(result.exit).toBe(0);
    expect(result.output).toContain('lifecycle: pursuing');
    expect(result.output).not.toContain('archived goal');
  });

  it('handles missing archive dir gracefully (returns 0 archives, falls through to "Run /goal:plan" message)', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rsr-no-archive-dir-'));
    // No .claude/goals/archive/ at all.
    const result = renderStatusReport(root);
    expect(result.output).toBe('No active goal. Run /goal:plan to start.');
  });
});
