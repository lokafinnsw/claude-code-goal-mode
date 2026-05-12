/**
 * End-to-end integration test for v3 explicit CLI flow.
 *
 * Proves that a 2-task plan with reviewer-required first task can be
 * driven to terminal `achieved` lifecycle WITHOUT emitting any goal-mode
 * tags AND WITHOUT firing the Stop-hook driver. Only the v3 CLI cores
 * are used.
 *
 * This is the regression lock for the v3 design contract: "agent calls
 * explicit verbs, engine never injects continuation prompts."
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { evidenceAdd } from '../engine/evidence-add.mjs';
import { achieveCursor } from '../engine/achieve.mjs';
import { submitVerdict } from '../engine/submit-verdict.mjs';
import { currentTask } from '../engine/current.mjs';
import { saveState, saveTree, loadState, loadTree } from '../engine/state.mjs';
import { activeDir } from '../engine/paths.mjs';

const tmpRoots = [];
afterEach(() => {
  for (const r of tmpRoots) try { fs.rmSync(r, { recursive: true, force: true }); } catch {}
  tmpRoots.length = 0;
});

function setupTwoTaskPlan() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-e2e-'));
  tmpRoots.push(root);
  fs.mkdirSync(activeDir(root), { recursive: true });
  saveTree(root, {
    schema_version: 2, goal_id: 'g', mission: 'm',
    created_at: '2026-05-12T00:00:00.000Z',
    approved_at: '2026-05-12T00:00:00.000Z',
    root: {
      id: 's', type: 'sprint', title: 'S', goal: 'sprint goal',
      acceptance_criteria: [], review: [], validate: null,
      work_front: null, status: 'pursuing', evidence: [],
      blocker_reason: null, review_attempts: 0, notes: [],
      children: [
        { id: 't1', type: 'task', title: 'Task 1', goal: 'g1',
          acceptance_criteria: ['ac0', 'ac1'],
          review: ['aaa-art-director'], validate: null,
          work_front: null, status: 'pursuing', evidence: [],
          blocker_reason: null, review_attempts: 0, notes: [], children: [] },
        { id: 't2', type: 'task', title: 'Task 2', goal: 'g2',
          acceptance_criteria: ['ac0'], review: [], validate: null,
          work_front: null, status: 'pending', evidence: [],
          blocker_reason: null, review_attempts: 0, notes: [], children: [] },
      ],
    },
  });
  saveState(root, {
    schema_version: 2, goal_id: 'g', lifecycle: 'pursuing', cursor: 't1',
    budget: { iterations: { used: 1, max: 100 }, tokens: { used: 0, max: 0 },
      wallclock: { started_at: new Date().toISOString(), max_seconds: 86400 } },
    session_id: 's', started_at: new Date().toISOString(),
    paused_at: null, ended_at: null, ended_reason: null,
    history: [], consecutive_silent_turns: 0,
  });
  return root;
}

describe('v3 explicit CLI end-to-end', () => {
  it('drives a 2-task plan to terminal achieved without tags or Stop-hook', () => {
    const root = setupTwoTaskPlan();

    const e1 = evidenceAdd(root, { criterion: 0, file: 'src/foo.ts', line: 10, note: 'AC0 proof' });
    expect(e1.ok).toBe(true);
    expect(e1.evidence_count).toBe(1);

    const e2 = evidenceAdd(root, { criterion: 1, command: 'npm test -- foo', exit_code: 0, note: 'AC1 green' });
    expect(e2.ok).toBe(true);
    expect(e2.evidence_count).toBe(2);

    const cur1 = currentTask(root);
    expect(cur1.ok).toBe(true);
    expect(cur1.cursor).toBe('t1');
    expect(cur1.evidence_count).toBe(2);
    expect(cur1.missing_criteria).toEqual([]);

    const ach1 = achieveCursor(root);
    expect(ach1.ok).toBe(true);
    expect(ach1.status).toBe('review-pending');
    expect(ach1.required_reviewers).toEqual(['aaa-art-director']);

    const v = submitVerdict(root, {
      agent: 'aaa-art-director',
      status: 'GO',
      text: 'all criteria covered, visual gate clean',
      scannedAgents: new Set(['aaa-art-director']),
    });
    expect(v.ok).toBe(true);
    expect(v.status).toBe('achieved');
    expect(v.next_cursor).toBe('t2');

    const cur2 = currentTask(root);
    expect(cur2.ok).toBe(true);
    expect(cur2.cursor).toBe('t2');
    expect(cur2.task.title).toBe('Task 2');
    expect(cur2.task.status).toBe('pursuing');  // v3 fix: new cursor promoted
    expect(cur2.missing_criteria).toEqual([0]);

    const e3 = evidenceAdd(root, { criterion: 0, file: 'src/bar.ts', line: 5 });
    expect(e3.ok).toBe(true);
    expect(e3.evidence_count).toBe(1);

    const ach2 = achieveCursor(root);
    expect(ach2.ok).toBe(true);
    expect(ach2.status).toBe('achieved');

    const finalState = loadState(root);
    expect(finalState.lifecycle).toBe('achieved');
    expect(finalState.ended_at).toBeTruthy();

    const finalTree = loadTree(root);
    expect(finalTree.root.children[0].status).toBe('achieved');
    expect(finalTree.root.children[1].status).toBe('achieved');
  });

  it('rejects a forged verdict (independence guard fires in full flow)', () => {
    const root = setupTwoTaskPlan();
    evidenceAdd(root, { criterion: 0, file: 'a' });
    evidenceAdd(root, { criterion: 1, file: 'b' });
    achieveCursor(root);

    const v = submitVerdict(root, {
      agent: 'aaa-art-director', status: 'GO', text: 'forged',
      scannedAgents: new Set(),
    });
    expect(v.ok).toBe(false);
    expect(v.error).toMatch(/independence/);

    const cur = currentTask(root);
    expect(cur.cursor).toBe('t1');
    expect(cur.task.status).toBe('review-pending');
  });

  it('escape-hatch routes to awaiting-manual-approval (full flow)', () => {
    const root = setupTwoTaskPlan();
    evidenceAdd(root, { criterion: 0, file: 'a' });
    evidenceAdd(root, { criterion: 1, file: 'b' });
    achieveCursor(root);

    const v = submitVerdict(root, {
      agent: 'aaa-art-director', status: 'REVISE',
      text: 'unavailable; user must run /goal-approve',
      scannedAgents: new Set(),
    });
    expect(v.ok).toBe(true);
    expect(v.status).toBe('blocked');

    const st = loadState(root);
    expect(st.lifecycle).toBe('awaiting-manual-approval');
  });
});
