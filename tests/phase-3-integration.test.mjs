import { describe, it, expect } from 'vitest';
import { parseTags } from '../engine/parse-tags.mjs';
import { applyMutations } from '../engine/apply-mutations.mjs';

// Helper: minimal one-task tree that the pipeline mutates.
function freshTree(criteria = ['c0', 'c1'], reviewers = []) {
  return {
    schema_version: 1,
    goal_id: 'g',
    mission: 'm',
    created_at: '2026-05-09T00:00:00.000Z',
    approved_at: null,
    root: {
      id: 't', type: 'task', title: 't', goal: 'g',
      acceptance_criteria: criteria,
      review: reviewers, validate: null, work_front: null,
      status: 'pursuing', evidence: [], blocker_reason: null,
      review_attempts: 0, notes: [], children: [],
    },
  };
}

function freshState(cursor = 't', iter = 1) {
  return {
    schema_version: 1, goal_id: 'g', lifecycle: 'pursuing', cursor,
    budget: { iterations: { used: iter, max: 100 }, tokens: { used: 0, max: 0 }, wallclock: { started_at: '2026-05-09T00:00:00.000Z', max_seconds: 0 } },
    session_id: 's', started_at: '2026-05-09T00:00:00.000Z',
    paused_at: null, ended_at: null, ended_reason: null,
    history: [],
  };
}

describe('Phase 3 integration: parseTags → applyMutations', () => {
  it('end-to-end: agent declares achieved with evidence, no review → cursor stays (single-task tree achieves)', () => {
    // Realistic agent message: prose + tags interspersed.
    const agentText = `
I implemented the refresh-token rotation in src/auth.ts. The old token is now
rejected at line 42, and a new token is issued via the rotateRefresh helper.

<evidence file="src/auth.ts" line="42" criterion="0" note="old token rejected via 401 at line 42" />
<evidence file="src/auth.ts" line="78" criterion="1" note="new token issued via rotateRefresh()" />
<evidence command="npm test -- src/auth" exit_code="0" criterion="1" note="auth tests green" />

All criteria covered. Marking the task as achieved.

<task-status>achieved</task-status>
`;

    const tags = parseTags(agentText);
    expect(tags.length).toBe(4);
    expect(tags.map(t => t.kind)).toEqual(['evidence', 'evidence', 'evidence', 'task-status']);

    const tree = freshTree(['c0', 'c1']); // no review[]
    const state = freshState();
    const { tree: t2, state: s2, history } = applyMutations(tree, state, tags, '2026-05-09T01:00:00.000Z');

    // Tree state: task achieved, 3 evidence records.
    expect(t2.root.status).toBe('achieved');
    expect(t2.root.evidence.length).toBe(3);
    expect(t2.root.evidence.map(e => e.criterion_index)).toEqual([0, 1, 1]);

    // State: lifecycle achieved (single task, no successor → cursor stays).
    expect(s2.lifecycle).toBe('achieved');
    expect(s2.cursor).toBe('t');

    // History: 3 evidence-added + 1 cursor-advanced + 1 achieved.
    expect(history.map(h => h.event)).toEqual(['evidence-added', 'evidence-added', 'evidence-added', 'cursor-advanced', 'achieved']);
  });

  it('end-to-end: review-required task → declares achieved → engine sets review-pending', () => {
    const agentText = `
Done. Let me request review.

<evidence file="src/x.ts" criterion="0" note="covers it" />
<task-status>achieved</task-status>
<review-request agents="art-x,design-y" />
`;

    const tags = parseTags(agentText);
    const tree = freshTree(['c0'], ['art-x', 'design-y']);
    const state = freshState();
    const { tree: t2, state: s2 } = applyMutations(tree, state, tags, '2026-05-09T01:00:00.000Z');

    expect(t2.root.status).toBe('review-pending');
    expect(s2.cursor).toBe('t');  // does not advance until verdicts land
  });

  it('end-to-end: review-pending → all-GO verdicts → engine advances + lifecycle achieved', () => {
    const agentText = `
Reviews are in.

<audit-verdict agent="art-x" status="GO">looks good</audit-verdict>
<audit-verdict agent="design-y" status="GO">approved</audit-verdict>
`;

    const tags = parseTags(agentText);
    expect(tags.length).toBe(2);
    expect(tags.every(t => t.kind === 'audit-verdict' && t.status === 'GO')).toBe(true);

    const tree = freshTree(['c0'], ['art-x', 'design-y']);
    tree.root.status = 'review-pending';
    tree.root.evidence = [
      { ts: '2026-05-09T00:00:00.000Z', iteration: 1, criterion_index: 0, file: 'x', line: null, commit: null, command: null, exit_code: null, note: 'n' },
    ];
    const state = freshState();
    const { tree: t2, state: s2 } = applyMutations(tree, state, tags, '2026-05-09T02:00:00.000Z');

    expect(t2.root.status).toBe('achieved');
    expect(s2.lifecycle).toBe('achieved');
  });

  it('end-to-end: review-pending → mixed NOGO/GO → engine returns to pursuing and increments review_attempts (regression for I3)', () => {
    const agentText = `
Verdicts:
<audit-verdict agent="art-x" status="GO">ok</audit-verdict>
<audit-verdict agent="design-y" status="NOGO">color contrast fails accessibility check</audit-verdict>
`;

    const tags = parseTags(agentText);
    const tree = freshTree(['c0'], ['art-x', 'design-y']);
    tree.root.status = 'review-pending';
    tree.root.review_attempts = 0;
    tree.root.evidence = [
      { ts: '2026-05-09T00:00:00.000Z', iteration: 1, criterion_index: 0, file: 'x', line: null, commit: null, command: null, exit_code: null, note: 'n' },
    ];
    const state = freshState();
    const { tree: t2, state: s2 } = applyMutations(tree, state, tags, '2026-05-09T02:00:00.000Z');

    expect(t2.root.status).toBe('pursuing');
    expect(t2.root.review_attempts).toBe(1);
    expect(s2.lifecycle).toBe('pursuing');
  });

  it('end-to-end: agent text mentions tag syntax in prose with `>` chars — parser does not silently drop tags (regression for parseTags I2)', () => {
    // Agent text where a NOTE attribute contains > and a code-fence contains
    // a literal example tag. Expected: real tags parse, fenced example also
    // parses (parser is intentionally markdown-unaware; consumer scopes input).
    const agentText = `
The rotation handler now rejects tokens older than 5 minutes:

<evidence file="src/auth.ts" criterion="0" note="rejects tokens with age > 5 min" />

Example I'm planning to add to docs:
\`\`\`xml
<evidence file="docs/example.md" line="1" criterion="0" note="example for docs" />
\`\`\`

<task-status>achieved</task-status>
`;

    const tags = parseTags(agentText);

    // Three tags expected: real evidence with `> 5 min` in note, fenced example
    // evidence (parsed because parser is markdown-unaware), and the achieved status.
    expect(tags.length).toBe(3);
    expect(tags.filter(t => t.kind === 'evidence').length).toBe(2);
    expect(tags.find(t => t.kind === 'evidence' && t.file === 'src/auth.ts').note).toBe('rejects tokens with age > 5 min');

    // applyMutations runs against this; both evidence records land on the cursor.
    const tree = freshTree(['c0']);
    const state = freshState();
    const { tree: t2, state: s2 } = applyMutations(tree, state, tags, '2026-05-09T01:00:00.000Z');
    expect(t2.root.evidence.length).toBe(2);
    expect(t2.root.status).toBe('achieved');
    expect(s2.lifecycle).toBe('achieved');
  });
});
