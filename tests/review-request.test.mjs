import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { reviewRequest, formatReviewRequest } from '../engine/review-request.mjs';
import { saveState, saveTree, loadState } from '../engine/state.mjs';
import { activeDir } from '../engine/paths.mjs';

const tmpRoots = [];
afterEach(() => {
  for (const r of tmpRoots) try { fs.rmSync(r, { recursive: true, force: true }); } catch {}
  tmpRoots.length = 0;
});

function setup({ status = 'review-pending', review = ['aaa-art-director'] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-rr-'));
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
        id: 't', type: 'task', title: 'Build feature X', goal: 'ship X',
        acceptance_criteria: ['c0', 'c1'],
        review, validate: 'npm test',
        work_front: null, status, evidence: [
          { ts: '2026-05-12T00:00:00.000Z', iteration: 1, criterion_index: 0,
            file: 'src/x.ts', line: 42, commit: null, command: null,
            exit_code: null, note: 'AC0 proof' },
          { ts: '2026-05-12T00:00:00.000Z', iteration: 1, criterion_index: 1,
            file: null, line: null, commit: null, command: 'npm test', exit_code: 0,
            note: 'green' },
        ],
        blocker_reason: null, review_attempts: 0, notes: [], children: [],
      }],
    },
  });
  saveState(root, {
    schema_version: 2, goal_id: 'g', lifecycle: 'pursuing', cursor: 't',
    budget: { iterations: { used: 1, max: 100 }, tokens: { used: 0, max: 0 },
      wallclock: { started_at: new Date().toISOString(), max_seconds: 86400 } },
    session_id: 's', started_at: new Date().toISOString(),
    paused_at: null, ended_at: null, ended_reason: null,
    history: [], consecutive_silent_turns: 0,
  });
  return root;
}

describe('reviewRequest', () => {
  it('returns full review packet on review-pending cursor', () => {
    const r = reviewRequest(setup());
    expect(r.ok).toBe(true);
    expect(r.cursor).toBe('t');
    expect(r.reviewers).toEqual(['aaa-art-director']);
    expect(r.task.title).toBe('Build feature X');
    expect(r.evidence_summary).toHaveLength(2);
    expect(r.validate).toBe('npm test');
    // template loaded — audit-instructions.md mentions verdict GO/NOGO/REVISE
    expect(r.template).toMatch(/verdict/i);
    expect(r.template).toMatch(/GO|NOGO|REVISE/);
  });

  it('rejects when cursor not review-pending', () => {
    const r = reviewRequest(setup({ status: 'pursuing' }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/review-pending/);
  });

  it('rejects when no reviewers configured (empty review[])', () => {
    const r = reviewRequest(setup({ review: [] }));
    // status precondition fails first (review-pending requires review.length>0
    // via achieve flow); but if someone hand-sets status=review-pending with
    // empty review[], we still reject with no-reviewers error.
    // setup() defaults to review-pending status, and the helper sets review:[]
    // which means cursor.review.length === 0 — our function catches this.
    expect(r.ok).toBe(false);
  });

  it('rejects when no active goal', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-rr-nogoal-'));
    tmpRoots.push(root);
    const r = reviewRequest(root);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/No active goal/);
  });
});

describe('formatReviewRequest', () => {
  it('renders multiline output with reviewer list + ACs + evidence + workflow + template', () => {
    const s = formatReviewRequest(reviewRequest(setup()));
    expect(s).toMatch(/Review required for task t/);
    expect(s).toMatch(/Reviewers to dispatch:/);
    expect(s).toMatch(/- aaa-art-director/);
    expect(s).toMatch(/\(#0\) c0/);
    expect(s).toMatch(/\(#1\) c1/);
    expect(s).toMatch(/Evidence collected/);
    expect(s).toMatch(/src\/x\.ts:42/);
    expect(s).toMatch(/npm test/);  // validate command
    expect(s).toMatch(/Workflow:/);
    expect(s).toMatch(/audit-instructions template/);
  });

  it('emits error prefix on !ok', () => {
    const s = formatReviewRequest({ ok: false, error: 'x' });
    expect(s).toBe('❌ x');
  });
});
