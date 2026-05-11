import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanAgentInvocations } from '../engine/transcript.mjs';
import { applyMutations } from '../engine/apply-mutations.mjs';

function mktmp(name) {
  return path.join(os.tmpdir(), `indep-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
}

function writeTranscript(rows) {
  const p = mktmp('tr');
  fs.writeFileSync(p, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return p;
}

function agentToolUseRow(subagentType, ts = null) {
  return {
    timestamp: ts ?? new Date().toISOString(),
    message: {
      role: 'assistant',
      content: [
        { type: 'text', text: 'dispatching reviewer' },
        { type: 'tool_use', name: 'Agent', id: 'agent-1', input: { subagent_type: subagentType, description: 'review', prompt: 'check it' } },
      ],
    },
  };
}

function plainAssistantRow(text, ts = null) {
  return {
    timestamp: ts ?? new Date().toISOString(),
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  };
}

// ── scanAgentInvocations ───────────────────────────────────────────────────

describe('scanAgentInvocations', () => {
  it('returns empty set for missing transcript', () => {
    expect(scanAgentInvocations('/tmp/nonexistent-' + Date.now() + '.jsonl').size).toBe(0);
  });

  it('returns empty set when transcript has no Agent tool_use blocks', () => {
    const p = writeTranscript([plainAssistantRow('hello world')]);
    expect(scanAgentInvocations(p).size).toBe(0);
  });

  it('returns set with one subagent_type when one Agent call present', () => {
    const p = writeTranscript([agentToolUseRow('rpg-game-designer')]);
    const s = scanAgentInvocations(p);
    expect(s.has('rpg-game-designer')).toBe(true);
    expect(s.size).toBe(1);
  });

  it('returns set with multiple distinct subagent_types', () => {
    const p = writeTranscript([
      agentToolUseRow('art-director'),
      agentToolUseRow('rpg-game-designer'),
      agentToolUseRow('art-director'), // duplicate — set dedupes
    ]);
    const s = scanAgentInvocations(p);
    expect(s.size).toBe(2);
    expect(s.has('art-director')).toBe(true);
    expect(s.has('rpg-game-designer')).toBe(true);
  });

  it('excludes Agent calls older than sinceTs', () => {
    const oldTs = new Date(Date.now() - 60_000).toISOString();
    const newTs = new Date().toISOString();
    const sinceTs = new Date(Date.now() - 30_000).toISOString();
    const p = writeTranscript([
      agentToolUseRow('old-reviewer', oldTs),
      agentToolUseRow('new-reviewer', newTs),
    ]);
    const s = scanAgentInvocations(p, sinceTs);
    expect(s.has('new-reviewer')).toBe(true);
    expect(s.has('old-reviewer')).toBe(false);
  });

  it('keeps entries with no timestamp (fail-open)', () => {
    const p = writeTranscript([
      { message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Agent', input: { subagent_type: 'no-ts-reviewer' } }] } },
    ]);
    const s = scanAgentInvocations(p, new Date().toISOString());
    expect(s.has('no-ts-reviewer')).toBe(true);
  });
});

// ── applyMutations reviewer-independence enforcement ───────────────────────

function makeTree({ reviewAgents = ['art-director'] } = {}) {
  return {
    schema_version: 2,
    goal_id: 'g',
    mission: 'm',
    created_at: new Date().toISOString(),
    approved_at: new Date().toISOString(),
    root: {
      id: 'sprint-1',
      type: 'sprint',
      title: 'S',
      goal: 'sg',
      acceptance_criteria: ['c'],
      review: [],
      validate: null,
      work_front: null,
      status: 'pending',
      evidence: [],
      blocker_reason: null,
      review_attempts: 0,
      notes: [],
      children: [
        {
          id: 'sprint-1.epic-1',
          type: 'epic',
          title: 'E',
          goal: 'eg',
          acceptance_criteria: ['c'],
          review: [],
          validate: null,
          work_front: null,
          status: 'pending',
          evidence: [],
          blocker_reason: null,
          review_attempts: 0,
          notes: [],
          children: [
            {
              id: 'sprint-1.epic-1.task-1',
              type: 'task',
              title: 'T',
              goal: 'tg',
              acceptance_criteria: ['ac0'],
              review: reviewAgents,
              validate: null,
              work_front: null,
              status: 'review-pending',
              evidence: [
                { ts: new Date().toISOString(), iteration: 0, criterion_index: 0, file: 'x', line: null, commit: null, command: null, exit_code: null, note: 'done' },
              ],
              blocker_reason: null,
              review_attempts: 0,
              notes: [],
              children: [],
            },
          ],
        },
      ],
    },
  };
}

function makeReviewPendingState() {
  return {
    schema_version: 2,
    goal_id: 'g',
    lifecycle: 'pursuing',
    cursor: 'sprint-1.epic-1.task-1',
    budget: {
      iterations: { used: 0, max: 100 },
      tokens: { used: 0, max: 1_000_000 },
      wallclock: { started_at: new Date().toISOString(), max_seconds: 86400 },
    },
    session_id: 'sess',
    started_at: new Date().toISOString(),
    paused_at: null,
    ended_at: null,
    ended_reason: null,
    history: [],
  };
}

describe('applyMutations reviewer-independence enforcement', () => {
  it('accepts verdict when scannedAgents contains the verdict agent', () => {
    const tree = makeTree({ reviewAgents: ['art-director'] });
    const state = makeReviewPendingState();
    const tags = [{ kind: 'audit-verdict', agent: 'art-director', status: 'GO', text: 'ok' }];
    const ts = new Date().toISOString();
    const r = applyMutations(tree, state, tags, ts, {
      scannedAgents: new Set(['art-director']),
    });
    // Verdict accepted → task achieved → cursor advances (here to itself since only one task)
    expect(r.tree.root.children[0].children[0].status).toBe('achieved');
    const verdictEv = r.history.find((h) => h.event === 'review-verdict');
    expect(verdictEv.payload.agent).toBe('art-director');
    expect(verdictEv.payload.rejected).toBeUndefined();
  });

  it('rejects verdict when scannedAgents does NOT contain the verdict agent', () => {
    const tree = makeTree({ reviewAgents: ['art-director'] });
    const state = makeReviewPendingState();
    const tags = [{ kind: 'audit-verdict', agent: 'art-director', status: 'GO', text: 'fabricated' }];
    const ts = new Date().toISOString();
    const r = applyMutations(tree, state, tags, ts, {
      scannedAgents: new Set([]), // empty — no real dispatch
    });
    // Verdict rejected → task stays review-pending
    expect(r.tree.root.children[0].children[0].status).toBe('review-pending');
    const verdictEv = r.history.find((h) => h.event === 'review-verdict');
    expect(verdictEv.payload.rejected).toBe(true);
    expect(verdictEv.payload.reason).toMatch(/no Agent dispatch/);
  });

  it('multi-reviewer requires all agents in scannedAgents to be accepted', () => {
    const tree = makeTree({ reviewAgents: ['art-director', 'rpg-game-designer'] });
    const state = makeReviewPendingState();
    const tags = [
      { kind: 'audit-verdict', agent: 'art-director', status: 'GO', text: 'art ok' },
      { kind: 'audit-verdict', agent: 'rpg-game-designer', status: 'GO', text: 'design ok' },
    ];
    const ts = new Date().toISOString();
    // Only art-director was actually dispatched
    const r = applyMutations(tree, state, tags, ts, {
      scannedAgents: new Set(['art-director']),
    });
    // rpg-game-designer verdict rejected; therefore not all required reviewers
    // returned a GO → task stays review-pending.
    expect(r.tree.root.children[0].children[0].status).toBe('review-pending');
    const events = r.history.filter((h) => h.event === 'review-verdict');
    expect(events).toHaveLength(2);
    const rejected = events.find((e) => e.payload.agent === 'rpg-game-designer');
    expect(rejected.payload.rejected).toBe(true);
    const accepted = events.find((e) => e.payload.agent === 'art-director');
    expect(accepted.payload.rejected).toBeUndefined();
  });

  it('when opts.scannedAgents is undefined, verdicts pass through unchanged (backward compat)', () => {
    const tree = makeTree({ reviewAgents: ['art-director'] });
    const state = makeReviewPendingState();
    const tags = [{ kind: 'audit-verdict', agent: 'art-director', status: 'GO', text: 'ok' }];
    const ts = new Date().toISOString();
    const r = applyMutations(tree, state, tags, ts, {}); // no scannedAgents key
    expect(r.tree.root.children[0].children[0].status).toBe('achieved');
  });

  it('rejected verdict counts cursor.review_attempts as a normal cycle? — assertion: no increment from rejection alone', () => {
    const tree = makeTree({ reviewAgents: ['art-director'] });
    const state = makeReviewPendingState();
    const tags = [{ kind: 'audit-verdict', agent: 'art-director', status: 'GO', text: 'fabricated' }];
    const ts = new Date().toISOString();
    const r = applyMutations(tree, state, tags, ts, {
      scannedAgents: new Set([]),
    });
    // review_attempts should NOT increment from a rejected verdict — that
    // would let a stuck agent escalate to unmet by spamming fake verdicts.
    expect(r.tree.root.children[0].children[0].review_attempts).toBe(0);
  });
});
