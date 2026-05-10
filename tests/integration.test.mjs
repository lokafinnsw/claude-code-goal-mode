import { describe, it, expect } from 'vitest';
import { runStopHook } from '../engine/stop-hook.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { saveState, saveTree } from '../engine/state.mjs';

function setupProject(tree, state, transcriptText) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'goal-int-'));
  saveTree(root, tree);
  saveState(root, state);
  const tPath = path.join(root, 'transcript.jsonl');
  fs.writeFileSync(tPath, transcriptText);
  return { root, tPath };
}

const minimalTree = () => ({
  schema_version: 1, goal_id: 'g', mission: 'm', created_at: '2026-05-09T00:00:00.000Z', approved_at: null,
  root: {
    id: 't', type: 'task', title: 'T', goal: 'g', acceptance_criteria: ['c0'], review: [], validate: null, work_front: null, status: 'pursuing',
    evidence: [], blocker_reason: null, review_attempts: 0, notes: [], children: [],
  },
});

const pursuingState = (sessionId = 'sess-1') => ({
  schema_version: 1, goal_id: 'g', lifecycle: 'pursuing', cursor: 't',
  budget: { iterations: { used: 0, max: 100 }, tokens: { used: 0, max: 1_000_000 }, wallclock: { started_at: new Date().toISOString(), max_seconds: 14400 } },
  session_id: sessionId,
  started_at: new Date().toISOString(), paused_at: null, ended_at: null, ended_reason: null, history: [],
});

describe('runStopHook integration', () => {
  it('returns block decision with rendered continuation when pursuing', async () => {
    const { root, tPath } = setupProject(minimalTree(), pursuingState(), JSON.stringify({
      message: { role: 'assistant', content: [{ type: 'text', text: 'no tags here' }] },
    }) + '\n');
    const result = await runStopHook({ stdin: { session_id: 'sess-1', transcript_path: tPath }, projectRoot: root });
    expect(result.exit).toBe(0);
    expect(result.stdout.decision).toBe('block');
    expect(result.stdout.reason).toContain('Goal continuation');
    expect(result.stdout.systemMessage).toMatch(/🎯/);
  });

  it('exits 0 with no output when session_id mismatches', async () => {
    const { root, tPath } = setupProject(minimalTree(), pursuingState('sess-1'), '');
    const result = await runStopHook({ stdin: { session_id: 'sess-other', transcript_path: tPath }, projectRoot: root });
    expect(result.exit).toBe(0);
    expect(result.stdout).toBeNull();
  });

  it('exits 0 when no goal active (state file missing)', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'goal-int-'));
    const tPath = path.join(root, 't.jsonl');
    fs.writeFileSync(tPath, '');
    const result = await runStopHook({ stdin: { session_id: 'sess-1', transcript_path: tPath }, projectRoot: root });
    expect(result.exit).toBe(0);
    expect(result.stdout).toBeNull();
  });

  it('on lifecycle paused returns exit 0 with no output', async () => {
    const tree = minimalTree();
    const state = pursuingState();
    state.lifecycle = 'paused';
    const { root, tPath } = setupProject(tree, state, '');
    const result = await runStopHook({ stdin: { session_id: 'sess-1', transcript_path: tPath }, projectRoot: root });
    expect(result.exit).toBe(0);
    expect(result.stdout).toBeNull();
  });

  // NEW: agent achieves task via tags → engine renders final-summary.md (lifecycle achieved)
  it('renders final-summary when agent achieves via tags (lifecycle transitions to achieved)', async () => {
    const transcriptObj = {
      message: {
        role: 'assistant',
        content: [{
          type: 'text',
          text: '<evidence file="x" criterion="0" note="done" />\n<task-status>achieved</task-status>',
        }],
      },
    };
    const { root, tPath } = setupProject(minimalTree(), pursuingState(), JSON.stringify(transcriptObj) + '\n');
    const result = await runStopHook({ stdin: { session_id: 'sess-1', transcript_path: tPath }, projectRoot: root });
    expect(result.exit).toBe(0);
    expect(result.stdout.decision).toBe('block');
    expect(result.stdout.systemMessage).toBe('✅ goal achieved');
    expect(result.stdout.reason).toContain('Goal achieved');
  });

  // NEW: agent blocks task 3x → engine renders unmet-summary.md (lifecycle transitions to unmet)
  it('renders unmet-summary when task blocks 3x in a row (lifecycle transitions to unmet)', async () => {
    // Set up a tree+state that's already at review_attempts=2 with 2 prior node-blocked events.
    const tree = minimalTree();
    const state = pursuingState();
    state.history = [
      { ts: '2026-05-09T00:00:00.000Z', iteration: 1, event: 'node-blocked', node_id: 't', payload: {} },
      { ts: '2026-05-09T00:00:01.000Z', iteration: 2, event: 'node-blocked', node_id: 't', payload: {} },
    ];
    tree.root.review_attempts = 2;
    tree.root.status = 'pursuing';
    state.budget.iterations.used = 2;

    // Now an agent text emits another block → that's #3.
    const transcriptObj = {
      message: {
        role: 'assistant',
        content: [{
          type: 'text',
          text: '<task-status>blocked</task-status>\n<blocker>still cannot solve</blocker>',
        }],
      },
    };
    const { root, tPath } = setupProject(tree, state, JSON.stringify(transcriptObj) + '\n');

    const result = await runStopHook({ stdin: { session_id: 'sess-1', transcript_path: tPath }, projectRoot: root });
    expect(result.exit).toBe(0);
    expect(result.stdout.decision).toBe('block');
    expect(result.stdout.systemMessage).toBe('🔴 goal unmet');
    expect(result.stdout.reason).toContain('could not be completed');
    expect(result.stdout.reason).toContain('still cannot solve');
  });

  // NEW: review-pending cursor renders continuation-review.md
  it('renders continuation-review when cursor is review-pending', async () => {
    const tree = minimalTree();
    tree.root.review = ['art-x'];
    tree.root.status = 'review-pending';
    tree.root.evidence = [
      { ts: '2026-05-09T00:00:00.000Z', iteration: 1, criterion_index: 0, file: 'x', line: null, commit: null, command: null, exit_code: null, note: 'n' },
    ];
    const state = pursuingState();
    state.cursor = 't';

    const { root, tPath } = setupProject(tree, state, JSON.stringify({
      message: { role: 'assistant', content: [{ type: 'text', text: 'no tags' }] },
    }) + '\n');

    const result = await runStopHook({ stdin: { session_id: 'sess-1', transcript_path: tPath }, projectRoot: root });
    expect(result.exit).toBe(0);
    expect(result.stdout.decision).toBe('block');
    expect(result.stdout.reason).toContain('review-pending');
    expect(result.stdout.reason).toContain('art-x');
  });
});

describe('runStopHook hardening fix-ups', () => {
  // I-1: code-fenced and inline-backtick example tags must be ignored
  it('does not extract tags from fenced code blocks (I-1)', async () => {
    const transcriptObj = {
      message: {
        role: 'assistant',
        content: [{
          type: 'text',
          text: 'Here is an example of how to emit a status:\n\n```xml\n<task-status>achieved</task-status>\n<evidence file="x" criterion="0" note="example" />\n```\n\nI am still working on it; nothing is achieved yet.',
        }],
      },
    };
    const { root, tPath } = setupProject(minimalTree(), pursuingState(), JSON.stringify(transcriptObj) + '\n');
    const result = await runStopHook({ stdin: { session_id: 'sess-1', transcript_path: tPath }, projectRoot: root });
    // The agent should still be in pursuing — example tags must NOT have been extracted.
    expect(result.stdout.systemMessage).toMatch(/🎯/);
    expect(result.stdout.reason).toContain('Goal continuation');
    expect(result.stdout.reason).not.toContain('Goal achieved');
  });

  it('does not extract tags from inline backtick spans (I-1)', async () => {
    const transcriptObj = {
      message: {
        role: 'assistant',
        content: [{
          type: 'text',
          text: 'Per the prompt, when done I should emit `<task-status>achieved</task-status>`. I am still working.',
        }],
      },
    };
    const { root, tPath } = setupProject(minimalTree(), pursuingState(), JSON.stringify(transcriptObj) + '\n');
    const result = await runStopHook({ stdin: { session_id: 'sess-1', transcript_path: tPath }, projectRoot: root });
    expect(result.stdout.systemMessage).toMatch(/🎯/);
    expect(result.stdout.reason).not.toContain('Goal achieved');
  });

  it('STILL extracts tags that appear in canonical prose (I-1 regression lock)', async () => {
    const transcriptObj = {
      message: {
        role: 'assistant',
        content: [{
          type: 'text',
          text: 'I implemented the feature and tested it.\n\n<evidence file="x" criterion="0" note="all done" />\n<task-status>achieved</task-status>',
        }],
      },
    };
    const { root, tPath } = setupProject(minimalTree(), pursuingState(), JSON.stringify(transcriptObj) + '\n');
    const result = await runStopHook({ stdin: { session_id: 'sess-1', transcript_path: tPath }, projectRoot: root });
    expect(result.stdout.systemMessage).toBe('✅ goal achieved');
  });

  // I-4: notes-digest is written on terminal lifecycle iterations
  it('writes notes-digest entry on achieved iteration (I-4)', async () => {
    const transcriptObj = {
      message: {
        role: 'assistant',
        content: [{
          type: 'text',
          text: '<evidence file="x" criterion="0" note="done" />\n<task-status>achieved</task-status>',
        }],
      },
    };
    const { root, tPath } = setupProject(minimalTree(), pursuingState(), JSON.stringify(transcriptObj) + '\n');
    await runStopHook({ stdin: { session_id: 'sess-1', transcript_path: tPath }, projectRoot: root });
    const notes = fs.readFileSync(path.join(root, '.claude', 'goals', 'active', 'notes.md'), 'utf8');
    expect(notes).toContain('lifecycle=achieved');
  });

  it('writes notes-digest entry on unmet iteration (I-4)', async () => {
    const tree = minimalTree();
    const state = pursuingState();
    state.history = [
      { ts: '2026-05-09T01:00:00.000Z', iteration: 1, event: 'node-blocked', node_id: 't', payload: {} },
      { ts: '2026-05-09T02:00:00.000Z', iteration: 2, event: 'node-blocked', node_id: 't', payload: {} },
    ];
    tree.root.review_attempts = 2;
    state.budget.iterations.used = 2;
    const transcriptObj = {
      message: {
        role: 'assistant',
        content: [{
          type: 'text',
          text: '<task-status>blocked</task-status>\n<blocker>still cannot solve</blocker>',
        }],
      },
    };
    const { root, tPath } = setupProject(tree, state, JSON.stringify(transcriptObj) + '\n');
    await runStopHook({ stdin: { session_id: 'sess-1', transcript_path: tPath }, projectRoot: root });
    const notes = fs.readFileSync(path.join(root, '.claude', 'goals', 'active', 'notes.md'), 'utf8');
    expect(notes).toContain('lifecycle=unmet');
  });
});

describe('runStopHook triple budget', () => {
  it('on token budget exhaustion: renders budget-limit prompt + lifecycle=budget-limited', async () => {
    // Build transcript with high token usage; tokens.max=5000 will be exceeded.
    const transcriptText = JSON.stringify({
      message: {
        role: 'assistant',
        usage: { input_tokens: 5000, output_tokens: 3000, cache_creation_input_tokens: 0 },
      },
    }) + '\n';

    const tree = minimalTree();
    const state = pursuingState();
    state.budget.tokens.max = 5000;
    const { root, tPath } = setupProject(tree, state, transcriptText);

    const result = await runStopHook({
      stdin: { session_id: 'sess-1', transcript_path: tPath },
      projectRoot: root,
    });

    expect(result.stdout.systemMessage).toMatch(/tokens budget exhausted/);
    expect(result.stdout.reason).toContain('budget exhausted');
    expect(result.stdout.reason).toContain('tokens');

    const newState = JSON.parse(fs.readFileSync(path.join(root, '.claude/goals/active/state.json'), 'utf8'));
    expect(newState.lifecycle).toBe('budget-limited');
    expect(newState.ended_reason).toBe('tokens budget exhausted');
    const lastEvent = newState.history[newState.history.length - 1];
    expect(lastEvent.event).toBe('budget-exhausted');
    expect(lastEvent.payload.kind).toBe('tokens');
  });

  it('on iterations budget exhaustion: renders budget-limit prompt + lifecycle=budget-limited', async () => {
    const transcriptText = JSON.stringify({
      message: { role: 'assistant', content: [{ type: 'text', text: 'no tags' }] },
    }) + '\n';

    const tree = minimalTree();
    const state = pursuingState();
    state.budget.iterations.used = 49;  // increment in stop-hook → 50, equals max → exhausted
    state.budget.iterations.max = 50;
    const { root, tPath } = setupProject(tree, state, transcriptText);

    const result = await runStopHook({
      stdin: { session_id: 'sess-1', transcript_path: tPath },
      projectRoot: root,
    });

    expect(result.stdout.systemMessage).toMatch(/iterations budget exhausted/);

    const newState = JSON.parse(fs.readFileSync(path.join(root, '.claude/goals/active/state.json'), 'utf8'));
    expect(newState.lifecycle).toBe('budget-limited');
    expect(newState.ended_reason).toBe('iterations budget exhausted');
  });

  it('on wallclock budget exhaustion: renders budget-limit prompt + lifecycle=budget-limited', async () => {
    const transcriptText = JSON.stringify({
      message: { role: 'assistant', content: [{ type: 'text', text: 'no tags' }] },
    }) + '\n';

    const tree = minimalTree();
    const state = pursuingState();
    state.budget.wallclock.started_at = new Date(Date.now() - 700_000).toISOString();  // ~11.7 min ago
    state.budget.wallclock.max_seconds = 600;  // 10 min max
    const { root, tPath } = setupProject(tree, state, transcriptText);

    const result = await runStopHook({
      stdin: { session_id: 'sess-1', transcript_path: tPath },
      projectRoot: root,
    });

    expect(result.stdout.systemMessage).toMatch(/wallclock budget exhausted/);

    const newState = JSON.parse(fs.readFileSync(path.join(root, '.claude/goals/active/state.json'), 'utf8'));
    expect(newState.lifecycle).toBe('budget-limited');
    expect(newState.ended_reason).toBe('wallclock budget exhausted');
  });

  it('budget-limit fires BEFORE applyMutations runs (tags in transcript are not processed)', async () => {
    // Transcript has both high token usage AND a task-status:achieved tag.
    // If budget check ran AFTER applyMutations, the cursor would advance.
    // Confirm: cursor stays put, lifecycle goes budget-limited.
    const transcriptText = JSON.stringify({
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: '<evidence file="x" criterion="0" note="done" />\n<task-status>achieved</task-status>' }],
        usage: { input_tokens: 5000, output_tokens: 3000 },
      },
    }) + '\n';

    const tree = minimalTree();
    const state = pursuingState();
    state.budget.tokens.max = 5000;
    const { root, tPath } = setupProject(tree, state, transcriptText);

    await runStopHook({
      stdin: { session_id: 'sess-1', transcript_path: tPath },
      projectRoot: root,
    });

    const newTree = JSON.parse(fs.readFileSync(path.join(root, '.claude/goals/active/tree.json'), 'utf8'));
    expect(newTree.root.status).toBe('pursuing');  // NOT 'achieved' — applyMutations did not run
    expect(newTree.root.evidence).toEqual([]);  // no evidence accumulated
  });

  it('does not fire budget-limit when all axes are within budget', async () => {
    const transcriptText = JSON.stringify({
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'normal turn' }],
        usage: { input_tokens: 100, output_tokens: 50 },
      },
    }) + '\n';

    const tree = minimalTree();
    const state = pursuingState();
    state.budget.tokens.max = 1_000_000;  // way more than 150
    const { root, tPath } = setupProject(tree, state, transcriptText);

    const result = await runStopHook({
      stdin: { session_id: 'sess-1', transcript_path: tPath },
      projectRoot: root,
    });

    // Normal continuation prompt, NOT budget-limit.
    expect(result.stdout.systemMessage).toMatch(/🎯/);  // normal pursuing emoji
    expect(result.stdout.reason).not.toContain('budget exhausted');

    const newState = JSON.parse(fs.readFileSync(path.join(root, '.claude/goals/active/state.json'), 'utf8'));
    expect(newState.lifecycle).toBe('pursuing');
    expect(newState.budget.tokens.used).toBe(150);  // tallied correctly
  });

  it('tallies tokens across multiple assistant rows in transcript', async () => {
    const transcriptText = [
      { message: { role: 'assistant', usage: { input_tokens: 100, output_tokens: 50 } } },
      { message: { role: 'assistant', content: [{ type: 'text', text: 'no tags' }], usage: { input_tokens: 200, output_tokens: 100 } } },
    ].map(r => JSON.stringify(r)).join('\n');

    const tree = minimalTree();
    const state = pursuingState();
    const { root, tPath } = setupProject(tree, state, transcriptText);

    await runStopHook({
      stdin: { session_id: 'sess-1', transcript_path: tPath },
      projectRoot: root,
    });

    const newState = JSON.parse(fs.readFileSync(path.join(root, '.claude/goals/active/state.json'), 'utf8'));
    expect(newState.budget.tokens.used).toBe(450);  // 100+50+200+100
  });
});

describe('runStopHook PLUGIN_ROOT runtime resolution (Bug 3)', () => {
  it('honors CLAUDE_PLUGIN_ROOT set after module import', async () => {
    // Import once (already done at top of file). Now override env.
    const origPluginRoot = process.env.CLAUDE_PLUGIN_ROOT;

    // Setup: a temp dir with custom prompts/ that produces a distinguishable token.
    const customPluginRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'custom-plugin-'));
    fs.mkdirSync(path.join(customPluginRoot, 'prompts'), { recursive: true });
    fs.writeFileSync(
      path.join(customPluginRoot, 'prompts', 'continuation.md'),
      'CUSTOM_PROMPT_MARKER iteration {{iteration}}'
    );

    try {
      process.env.CLAUDE_PLUGIN_ROOT = customPluginRoot;

      const { root, tPath } = setupProject(minimalTree(), pursuingState(), JSON.stringify({
        message: { role: 'assistant', content: [{ type: 'text', text: 'no tags' }] },
      }) + '\n');

      const result = await runStopHook({
        stdin: { session_id: 'sess-1', transcript_path: tPath },
        projectRoot: root,
      });

      expect(result.stdout).not.toBeNull();
      expect(result.stdout.reason).toContain('CUSTOM_PROMPT_MARKER');
    } finally {
      if (origPluginRoot === undefined) delete process.env.CLAUDE_PLUGIN_ROOT;
      else process.env.CLAUDE_PLUGIN_ROOT = origPluginRoot;
    }
  });
});
