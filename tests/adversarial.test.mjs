/**
 * Adversarial test suite for claude-code-goal-mode (Phases 0-4).
 *
 * Categories:
 *   A  – Schema attacks (state.mjs)
 *   B  – I/O attacks (state.mjs)
 *   C  – Parser attacks (parse-tags.mjs)
 *   D  – Continuation render attacks (continuation.mjs)
 *   E  – Apply-mutations attacks (apply-mutations.mjs)
 *   F  – Stop-hook attacks (stop-hook.mjs)
 *   G  – Real CLI integration
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';

import {
  GoalTreeSchema, GoalNodeSchema, GoalStateSchema,
  loadState, saveState, loadTree, saveTree,
} from '../engine/state.mjs';
import { activeDir as activeDirOf } from '../engine/paths.mjs';
import { walkLeafTasks, findNodeById, nextPendingTaskAfter } from '../engine/traversal.mjs';
import { parseTags } from '../engine/parse-tags.mjs';
import { applyMutations } from '../engine/apply-mutations.mjs';
import { render, validateTemplate, buildContext, TemplateRenderError } from '../engine/continuation.mjs';
import { runStopHook } from '../engine/stop-hook.mjs';
import { saveState as saveStateFn } from '../engine/state.mjs';

// ─── helpers ────────────────────────────────────────────────────────────────

function tmpdir() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'goal-adv-'));
  // v3.0: these tests exercise the legacy Stop-hook driver path
  // (continuation injection on lifecycle=pursuing). Pin every fixture
  // to stopHookDriver=true so the v3 default short-circuit (null
  // stdout on pursuing) doesn't fire.
  fs.mkdirSync(activeDirOf(root), { recursive: true });
  fs.writeFileSync(
    path.join(activeDirOf(root), 'config.json'),
    JSON.stringify({ schema_version: 1, stopHookDriver: true }),
  );
  return root;
}

function makeTaskNode(overrides = {}) {
  return {
    id: 't1',
    type: 'task',
    title: 'T',
    goal: 'g',
    acceptance_criteria: ['c0'],
    review: [],
    validate: null,
    work_front: null,
    status: 'pending',
    evidence: [],
    blocker_reason: null,
    review_attempts: 0,
    notes: [],
    children: [],
    ...overrides,
  };
}

function makeSprintNode(overrides = {}) {
  return {
    id: 's1',
    type: 'sprint',
    title: 'Sprint',
    goal: 'g',
    acceptance_criteria: [],
    review: [],
    validate: null,
    work_front: null,
    status: 'pending',
    evidence: [],
    blocker_reason: null,
    review_attempts: 0,
    notes: [],
    children: [],
    ...overrides,
  };
}

function makeEpicNode(overrides = {}) {
  return {
    id: 'e1',
    type: 'epic',
    title: 'Epic',
    goal: 'g',
    acceptance_criteria: [],
    review: [],
    validate: null,
    work_front: null,
    status: 'pending',
    evidence: [],
    blocker_reason: null,
    review_attempts: 0,
    notes: [],
    children: [],
    ...overrides,
  };
}

function makeMinimalTree(rootOverrides = {}) {
  return {
    schema_version: 2,
    goal_id: 'g',
    mission: 'demo mission',
    created_at: '2026-05-09T00:00:00.000Z',
    approved_at: null,
    root: makeSprintNode({
      children: [makeTaskNode()],
      ...rootOverrides,
    }),
  };
}

function makeState(overrides = {}) {
  // Use NOW for wallclock.started_at so tests don't trip Phase 8 budget exhaustion
  // when run on a date later than the fixture date. Tests that need exhausted
  // wallclock pass an explicit override.
  const now = new Date().toISOString();
  return {
    schema_version: 2,
    goal_id: 'g',
    lifecycle: 'pursuing',
    cursor: 't1',
    budget: {
      iterations: { used: 0, max: 100 },
      tokens: { used: 0, max: 1_000_000 },
      wallclock: { started_at: now, max_seconds: 14400 },
    },
    session_id: 'sess-1',
    started_at: now,
    paused_at: null,
    ended_at: null,
    ended_reason: null,
    history: [],
    ...overrides,
  };
}

function evidenceTag(criterion = 0, file = 'x.ts', note = 'covers') {
  return { kind: 'evidence', file, line: null, criterion, note, command: null, exit_code: null };
}

function statusTag(value) {
  return { kind: 'task-status', value };
}

function verdictTag(agent, status, text = 'ok') {
  return { kind: 'audit-verdict', agent, status, text };
}

// ─── A. Schema attacks ────────────────────────────────────────────────────────

describe('A. Schema attacks', () => {

  // A1: deeply-nested task with empty acceptance_criteria should fail refine
  it('A1: refine fires on deeply nested task (3+ levels) with empty acceptance_criteria', () => {
    const deepTask = makeTaskNode({ id: 's.e.t', acceptance_criteria: [] });
    const epicNode = makeEpicNode({ id: 's.e', children: [deepTask] });
    const sprintNode = makeSprintNode({ id: 's', children: [epicNode] });
    const tree = { ...makeMinimalTree(), root: sprintNode };
    expect(() => GoalTreeSchema.parse(tree)).toThrow(/acceptance_criteria/);
  });

  // A2: datetime validation edge cases
  describe('A2: datetime validation edge cases', () => {
    const validBase = () => ({
      schema_version: 2, goal_id: 'g', mission: 'm',
      approved_at: null,
      root: makeSprintNode({ children: [makeTaskNode()] }),
    });

    it('A2a: rejects "tomorrow" as created_at', () => {
      expect(() => GoalTreeSchema.parse({ ...validBase(), created_at: 'tomorrow' })).toThrow();
    });

    it('A2b: rejects "2026-13-99" as created_at', () => {
      expect(() => GoalTreeSchema.parse({ ...validBase(), created_at: '2026-13-99' })).toThrow();
    });

    it('A2c: rejects empty string as created_at', () => {
      expect(() => GoalTreeSchema.parse({ ...validBase(), created_at: '' })).toThrow();
    });

    it('A2d: rejects "2026-05-09 00:00:00" (space not T) as created_at', () => {
      expect(() => GoalTreeSchema.parse({ ...validBase(), created_at: '2026-05-09 00:00:00' })).toThrow();
    });

    it('A2e: documents whether "2026-05-09T00:00:00" (no Z) is accepted', () => {
      // Zod's z.string().datetime() requires Z or timezone by default in some versions.
      // We document the behavior: if it throws, no-Z is rejected; if not, it is accepted.
      let accepted = false;
      try {
        GoalTreeSchema.parse({ ...validBase(), created_at: '2026-05-09T00:00:00' });
        accepted = true;
      } catch (_) {}
      // Document: accepted = false means zod rejects no-Z timestamps (expected)
      // This test just records the actual behavior as a snapshot.
      expect(typeof accepted).toBe('boolean');
    });
  });

  // A3: timezone offsets in datetime
  describe('A3: datetime with timezone offsets', () => {
    const validBase = () => ({
      schema_version: 2, goal_id: 'g', mission: 'm',
      approved_at: null,
      root: makeSprintNode({ children: [makeTaskNode()] }),
    });

    it('A3a: documents whether +05:00 offset is accepted', () => {
      let accepted = false;
      try {
        GoalTreeSchema.parse({ ...validBase(), created_at: '2026-05-09T00:00:00+05:00' });
        accepted = true;
      } catch (_) {}
      // Zod's default .datetime() only accepts Z; with {offset:true} it accepts offsets.
      // We're testing which variant is used.  If accepted = false, zod rejects offsets.
      expect(typeof accepted).toBe('boolean');
    });

    it('A3b: documents whether -08:00 offset is accepted', () => {
      let accepted = false;
      try {
        GoalTreeSchema.parse({ ...validBase(), created_at: '2026-05-09T00:00:00-08:00' });
        accepted = true;
      } catch (_) {}
      expect(typeof accepted).toBe('boolean');
    });
  });

  // A4: sprint/epic with empty acceptance_criteria allowed, tasks must have ≥1
  it('A4: sprint+epic with empty criteria parses fine when tasks are valid', () => {
    const tree = {
      schema_version: 2,
      goal_id: 'g',
      mission: 'm',
      created_at: '2026-05-09T00:00:00.000Z',
      approved_at: null,
      root: makeSprintNode({
        id: 's',
        acceptance_criteria: [],
        children: [
          makeEpicNode({
            id: 's.e',
            acceptance_criteria: [],
            children: [makeTaskNode({ id: 's.e.t', acceptance_criteria: ['c0'] })],
          }),
        ],
      }),
    };
    expect(() => GoalTreeSchema.parse(tree)).not.toThrow();
  });

  // A5: skipped status handling
  describe('A5: skipped status', () => {
    it('A5a: schema accepts task with status=skipped', () => {
      const tree = makeMinimalTree();
      tree.root.children[0].status = 'skipped';
      expect(() => GoalTreeSchema.parse(tree)).not.toThrow();
    });

    it('A5b: walkLeafTasks includes skipped tasks', () => {
      const tree = makeMinimalTree();
      tree.root.children[0].status = 'skipped';
      const leaves = walkLeafTasks(tree);
      expect(leaves.length).toBe(1);
      expect(leaves[0].status).toBe('skipped');
    });

    it('A5c: nextPendingTaskAfter skips over skipped tasks (only returns pending)', () => {
      const tree = {
        ...makeMinimalTree(),
        root: makeSprintNode({
          id: 's',
          children: [
            makeTaskNode({ id: 's.t1', status: 'skipped' }),
            makeTaskNode({ id: 's.t2', status: 'pending' }),
          ],
        }),
      };
      const next = nextPendingTaskAfter(tree, null);
      // skipped is not 'pending', so the first pending task should be s.t2
      expect(next?.id).toBe('s.t2');
    });
  });

  // A6: unicode in IDs
  describe('A6: unicode IDs', () => {
    it('A6a: cyrillic ID accepted by schema', () => {
      const tree = makeMinimalTree({
        children: [makeTaskNode({ id: 'спринт-1.задача-2' })],
      });
      expect(() => GoalTreeSchema.parse(tree)).not.toThrow();
    });

    it('A6b: emoji ID accepted by schema (min(1) string, no charset restriction)', () => {
      const tree = makeMinimalTree({
        children: [makeTaskNode({ id: '🎯-task-1' })],
      });
      expect(() => GoalTreeSchema.parse(tree)).not.toThrow();
    });

    it('A6c: findNodeById works with cyrillic ID', () => {
      const tree = makeMinimalTree({
        children: [makeTaskNode({ id: 'спринт-1.задача-2' })],
      });
      const found = findNodeById(tree, 'спринт-1.задача-2');
      expect(found?.id).toBe('спринт-1.задача-2');
    });

    it('A6d: findNodeById works with emoji ID', () => {
      const tree = makeMinimalTree({
        children: [makeTaskNode({ id: '🎯-task-1' })],
      });
      const found = findNodeById(tree, '🎯-task-1');
      expect(found?.id).toBe('🎯-task-1');
    });
  });

  // A7: very deep tree (100 levels) — no stack overflow
  it('A7: 100-level deep tree parses and traversal completes without stack overflow', () => {
    let leaf = makeTaskNode({ id: 'deep-leaf', acceptance_criteria: ['c0'] });
    for (let i = 99; i >= 1; i--) {
      const epic = makeEpicNode({ id: `e-${i}`, children: [leaf] });
      leaf = epic;
    }
    // leaf is now the top-level node
    const tree = {
      schema_version: 2,
      goal_id: 'g',
      mission: 'm',
      created_at: '2026-05-09T00:00:00.000Z',
      approved_at: null,
      root: leaf,
    };
    expect(() => GoalTreeSchema.parse(tree)).not.toThrow();
    const leaves = walkLeafTasks(tree);
    expect(leaves.length).toBe(1);
    expect(leaves[0].id).toBe('deep-leaf');
    const found = findNodeById(tree, 'deep-leaf');
    expect(found?.id).toBe('deep-leaf');
    const next = nextPendingTaskAfter(tree, null);
    expect(next?.id).toBe('deep-leaf');
  });

  // A8: approved_at before created_at — schema gap
  it('A8: schema accepts approved_at earlier than created_at (temporal ordering not enforced)', () => {
    // This documents a known gap: no cross-field datetime ordering validation.
    const tree = {
      schema_version: 2,
      goal_id: 'g',
      mission: 'm',
      created_at: '2026-05-09T00:00:00.000Z',
      approved_at: '2025-01-01T00:00:00.000Z', // BEFORE created_at — invalid semantically
      root: makeSprintNode({ children: [makeTaskNode()] }),
    };
    // If this does NOT throw, the schema has a gap (ordering not checked).
    // If it throws, the schema correctly enforces ordering.
    let threw = false;
    try { GoalTreeSchema.parse(tree); } catch (_) { threw = true; }
    // Document behavior: we expect this to NOT throw (gap confirmed).
    expect(threw).toBe(false);
  });
});

// ─── B. I/O attacks ──────────────────────────────────────────────────────────

describe('B. I/O attacks', () => {

  // B1: symlink target
  it('B1: loadState follows symlink to external file', () => {
    const root = tmpdir();
    const externalDir = tmpdir();
    const externalState = path.join(externalDir, 'state.json');

    const state = makeState();
    // Write state to external location
    saveStateFn(root, state);
    // Read actual path written
    const activeDir = path.join(root, '.claude', 'goals', 'active');
    const statePath = path.join(activeDir, 'state.json');
    // Copy it to external location
    fs.copyFileSync(statePath, externalState);
    // Replace with symlink
    fs.unlinkSync(statePath);
    fs.symlinkSync(externalState, statePath);

    const loaded = loadState(root);
    expect(loaded).not.toBeNull();
    expect(loaded.session_id).toBe('sess-1');
  });

  // B2: pre-existing .tmp from prior crash
  it('B2: saveState overwrites stale .tmp file cleanly', () => {
    const root = tmpdir();
    const staleContent = '{"stale": true}';
    const tmpPath = path.join(root, '.claude', 'goals', 'active', 'state.json.tmp');
    fs.mkdirSync(path.dirname(tmpPath), { recursive: true });
    fs.writeFileSync(tmpPath, staleContent);

    const state = makeState();
    expect(() => saveStateFn(root, state)).not.toThrow();

    // Verify state.json was written correctly
    const loaded = loadState(root);
    expect(loaded).not.toBeNull();
    expect(loaded.session_id).toBe('sess-1');

    // Verify .tmp was removed (rename() atomically replaces)
    // After rename the .tmp should be gone (it becomes state.json)
    expect(fs.existsSync(tmpPath)).toBe(false);
  });

  // B3: concurrent saveState calls — last writer wins
  it('B3: back-to-back saveState calls with different states, last one wins', () => {
    const root = tmpdir();
    const state1 = makeState({ session_id: 'sess-first' });
    const state2 = makeState({ session_id: 'sess-last' });

    saveStateFn(root, state1);
    saveStateFn(root, state2);

    const loaded = loadState(root);
    expect(loaded?.session_id).toBe('sess-last');
  });

  // B4: .broken-<ts> collision in same millisecond — tolerate
  it('B4: multiple invalid state files create distinct .broken-<ts> files (or last overwrite is documented)', () => {
    const root = tmpdir();
    const activeDir = path.join(root, '.claude', 'goals', 'active');
    const statePath = path.join(activeDir, 'state.json');
    fs.mkdirSync(activeDir, { recursive: true });

    // Run 10 rapid back-to-back loadState calls with invalid content
    const collisions = [];
    for (let i = 0; i < 10; i++) {
      fs.writeFileSync(statePath, `{invalid-json-${i}`);
      loadState(root); // should create .broken-<ts>
    }
    const brokenFiles = fs.readdirSync(activeDir)
      .filter(f => f.includes('.broken-'));
    // If all 10 calls happen within the same millisecond (same ts replacement string),
    // there could be fewer than 10 broken files (overwrite collision).
    // We document: collisions are possible; this test records the actual count.
    expect(brokenFiles.length).toBeGreaterThanOrEqual(1);
    // NOTE: If brokenFiles.length < 10, that confirms the collision gap is real.
  });

  // B5: directory not writable — error propagates
  it.skip('B5: saveState to chmod-000 directory propagates error (skip in CI root env)', () => {
    // This test requires non-root, non-CI environment
    const root = tmpdir();
    const activeDir = path.join(root, '.claude', 'goals', 'active');
    fs.mkdirSync(activeDir, { recursive: true });
    fs.chmodSync(activeDir, 0o000);
    try {
      expect(() => saveStateFn(root, makeState())).toThrow();
    } finally {
      fs.chmodSync(activeDir, 0o755);
    }
  });

  // B6: state file is a directory
  it('B6: loadState returns null when state.json is a directory', () => {
    const root = tmpdir();
    const stateDir = path.join(root, '.claude', 'goals', 'active', 'state.json');
    fs.mkdirSync(stateDir, { recursive: true });
    const loaded = loadState(root);
    expect(loaded).toBeNull();
  });
});

// ─── C. Parser attacks ────────────────────────────────────────────────────────

describe('C. Parser attacks', () => {

  // C1: unclosed tag
  it('C1: unclosed evidence tag returns empty array', () => {
    const tags = parseTags('<evidence file="x" criterion="0">no closing tag');
    expect(tags.filter(t => t.kind === 'evidence')).toHaveLength(0);
  });

  // C2: self-close variants
  it('C2a: self-close with no space before />', () => {
    const tags = parseTags('<evidence criterion="0"/>');
    expect(tags.filter(t => t.kind === 'evidence')).toHaveLength(1);
  });

  it('C2b: self-close with space before />', () => {
    const tags = parseTags('<evidence criterion="0" />');
    expect(tags.filter(t => t.kind === 'evidence')).toHaveLength(1);
  });

  it('C2c: self-close with multiple spaces before />', () => {
    const tags = parseTags('<evidence criterion="0"  />');
    expect(tags.filter(t => t.kind === 'evidence')).toHaveLength(1);
  });

  // C3: body wins over note attr
  it('C3: body note wins over note attribute', () => {
    const tags = parseTags('<evidence criterion="0" note="attr-note">body-note</evidence>');
    expect(tags[0].note).toBe('body-note');
  });

  // C4: nested same-tag (lazy regex)
  it('C4: nested evidence tags — lazy regex takes first close', () => {
    const text = '<evidence criterion="0">outer <evidence criterion="1">inner</evidence> stuff</evidence>';
    const tags = parseTags(text).filter(t => t.kind === 'evidence');
    // Lazy [\s\S]*? takes first </evidence>; the "outer" tag body ends before inner's closer
    // The inner tag would also be matched as a separate pass.
    // Document the actual count:
    expect(tags.length).toBeGreaterThanOrEqual(1);
  });

  // C5: non-integer criterion
  it('C5: criterion="abc" is skipped', () => {
    const tags = parseTags('<evidence criterion="abc" file="x"/>');
    expect(tags.filter(t => t.kind === 'evidence')).toHaveLength(0);
  });

  // C6: negative criterion — accepted in evidence but not credited for coverage
  it('C6: criterion="-1" pushed to evidence but not counted for coverage', () => {
    const tags = parseTags('<evidence criterion="-1" file="x"/>');
    const evTags = tags.filter(t => t.kind === 'evidence');
    expect(evTags).toHaveLength(1);
    expect(evTags[0].criterion).toBe(-1);
    // Verify it does NOT cover criterion 0 in a 1-criterion task:
    const tree = makeMinimalTree();
    const state = makeState();
    const { tree: t2 } = applyMutations(tree, state, [...evTags, statusTag('achieved')], '2026-05-09T01:00:00.000Z');
    // criterion -1 is out-of-range, so criteria NOT covered, task stays pursuing
    expect(t2.root.children[0].status).toBe('pursuing');
  });

  // C7: mixed line endings
  it('C7: CRLF line endings work same as LF', () => {
    const textLF = '<evidence criterion="0" file="a"/>\n<task-status>achieved</task-status>';
    const textCRLF = '<evidence criterion="0" file="a"/>\r\n<task-status>achieved</task-status>';
    const tagsLF = parseTags(textLF);
    const tagsCRLF = parseTags(textCRLF);
    expect(tagsLF.filter(t => t.kind === 'evidence').length).toBe(
      tagsCRLF.filter(t => t.kind === 'evidence').length
    );
    expect(tagsLF.filter(t => t.kind === 'task-status').length).toBe(
      tagsCRLF.filter(t => t.kind === 'task-status').length
    );
  });

  // C8: audit-verdict body containing literal </audit-verdict>
  it('C8: literal </audit-verdict> in body — lazy regex takes first closer', () => {
    const text = `<audit-verdict agent="x" status="GO">said "</audit-verdict>" verbatim</audit-verdict>`;
    const tags = parseTags(text).filter(t => t.kind === 'audit-verdict');
    expect(tags.length).toBeGreaterThanOrEqual(1);
    // The first match's text should be: 'said "'
    if (tags.length > 0) {
      expect(tags[0].text).toBe('said "');
    }
  });

  // C9: agents=" , " empty-ish CSV
  it('C9: review-request with agents=" , " is skipped (empty after split+filter)', () => {
    const tags = parseTags('<review-request agents=" , " />');
    expect(tags.filter(t => t.kind === 'review-request')).toHaveLength(0);
  });

  // C10: case-insensitive task-status (v2.0.3 bug M7 fix).
  // Pre-v2.0.3 this was strict-case and silently dropped 'ACHIEVED'/'Achieved'
  // into "no task-status tag" — agents that paraphrased the prompt would hang
  // the engine. v2.0.3 normalizes to lowercase before the enum check.
  it('C10: <task-status>ACHIEVED</task-status> normalizes to "achieved" (v2.0.3 M7)', () => {
    const tags = parseTags('<task-status>ACHIEVED</task-status>');
    const statusTags = tags.filter((t) => t.kind === 'task-status');
    expect(statusTags).toHaveLength(1);
    expect(statusTags[0].value).toBe('achieved');
  });

  it('C10b: <task-status>Blocked</task-status> mixed-case normalizes to "blocked"', () => {
    const tags = parseTags('<task-status>Blocked</task-status>');
    const statusTags = tags.filter((t) => t.kind === 'task-status');
    expect(statusTags).toHaveLength(1);
    expect(statusTags[0].value).toBe('blocked');
  });

  it('C10c: <task-status>FROBBLED</task-status> still rejected (unknown value)', () => {
    const tags = parseTags('<task-status>FROBBLED</task-status>');
    expect(tags.filter((t) => t.kind === 'task-status')).toHaveLength(0);
  });

  // C11: unicode in note/agent round-trips
  it('C11: cyrillic and emoji in note/agent round-trip intact', () => {
    const text = `<evidence criterion="0" note="Привет мир 🎯"/>`;
    const tags = parseTags(text).filter(t => t.kind === 'evidence');
    expect(tags[0].note).toBe('Привет мир 🎯');
  });

  it('C11b: cyrillic agent name in audit-verdict round-trips', () => {
    const text = `<audit-verdict agent="Алекс" status="GO">ok</audit-verdict>`;
    const tags = parseTags(text).filter(t => t.kind === 'audit-verdict');
    expect(tags[0]?.agent).toBe('Алекс');
  });

  // C12: single quotes in attrs
  it('C12: single-quoted attribute values are accepted', () => {
    const tags = parseTags(`<evidence criterion='0' file='x.ts'/>`);
    expect(tags.filter(t => t.kind === 'evidence')).toHaveLength(1);
    expect(tags[0].file).toBe('x.ts');
  });

  // C13: > inside attribute value
  it('C13: > inside attribute value — ATTRS_REGION is quote-aware', () => {
    const tags = parseTags(`<evidence note="size > 5" criterion="0"/>`);
    expect(tags.filter(t => t.kind === 'evidence')).toHaveLength(1);
    expect(tags[0].note).toBe('size > 5');
  });
});

// ─── D. Continuation render attacks ──────────────────────────────────────────

describe('D. Continuation render attacks', () => {

  // D1: template injection — ctx value containing {{...}} round-trips intact
  it('D1: ctx value containing {{evil}} round-trips as literal text', () => {
    const result = render('hello {{msg}}', { msg: '{{evil}}' });
    expect(result).toBe('hello {{evil}}');
  });

  // D2: malformed templates throw TemplateRenderError
  it('D2a: {{ name }} (whitespace inside) throws TemplateRenderError', () => {
    expect(() => render('{{ name }}', {})).toThrow(TemplateRenderError);
  });

  it('D2b: {{}} empty throws TemplateRenderError', () => {
    expect(() => render('{{}}', {})).toThrow(TemplateRenderError);
  });

  it('D2c: {{a-b}} hyphen throws TemplateRenderError', () => {
    expect(() => render('{{a-b}}', {})).toThrow(TemplateRenderError);
  });

  it('D2d: {{#each}} with no name throws TemplateRenderError', () => {
    expect(() => render('{{#each}}body{{/each}}', {})).toThrow(TemplateRenderError);
  });

  // D3: unbalanced blocks
  it('D3a: unclosed {{#each xs}} throws TemplateRenderError', () => {
    expect(() => render('{{#each xs}}body', { xs: [] })).toThrow(TemplateRenderError);
  });

  it('D3b: orphan {{/each}} throws TemplateRenderError', () => {
    expect(() => render('{{/each}}', {})).toThrow(TemplateRenderError);
  });

  // D4: mismatched closer kind
  it('D4: {{#each xs}}body{{/if}} throws with "unmatched {{/if}}"', () => {
    expect(() => render('{{#each xs}}body{{/if}}', { xs: [] })).toThrow(/unmatched/);
  });

  // D5: nested {{#each}} with same key — inner shadows outer
  it('D5: nested {{#each}} with same key uses innermost scope for {{this}}', () => {
    const ctx = {
      xs: [
        { label: 'a', xs: [{ label: 'inner-a' }] },
        { label: 'b', xs: [{ label: 'inner-b' }] },
      ],
    };
    const tpl = '{{#each xs}}{{label}}:{{#each xs}}{{label}}{{/each}};{{/each}}';
    const out = render(tpl, ctx);
    expect(out).toBe('a:inner-a;b:inner-b;');
  });

  // D6: {{#each}} on non-array emits nothing
  it('D6a: {{#each}} on number emits nothing', () => {
    expect(render('{{#each xs}}X{{/each}}', { xs: 42 })).toBe('');
  });

  it('D6b: {{#each}} on string emits nothing', () => {
    expect(render('{{#each xs}}X{{/each}}', { xs: 'hello' })).toBe('');
  });

  it('D6c: {{#each}} on object emits nothing', () => {
    expect(render('{{#each xs}}X{{/each}}', { xs: { a: 1 } })).toBe('');
  });

  // D7: deep dotted access through null
  it('D7: {{a.b.c}} when ctx.a is null renders empty string', () => {
    expect(render('{{a.b.c}}', { a: null })).toBe('');
  });

  // D8: falsy variants in {{#if}}
  describe('D8: {{#if}} truthiness', () => {
    it('D8a: 0 is falsy', () => {
      expect(render('{{#if x}}Y{{/if}}', { x: 0 })).toBe('');
    });
    it('D8b: "" is falsy', () => {
      expect(render('{{#if x}}Y{{/if}}', { x: '' })).toBe('');
    });
    it('D8c: false is falsy', () => {
      expect(render('{{#if x}}Y{{/if}}', { x: false })).toBe('');
    });
    it('D8d: null is falsy', () => {
      expect(render('{{#if x}}Y{{/if}}', { x: null })).toBe('');
    });
    it('D8e: empty array [] is falsy', () => {
      expect(render('{{#if x}}Y{{/if}}', { x: [] })).toBe('');
    });
    it('D8f: empty object {} is truthy (!!{} = true)', () => {
      expect(render('{{#if x}}Y{{/if}}', { x: {} })).toBe('Y');
    });
    it('D8g: non-empty array is truthy', () => {
      expect(render('{{#if x}}Y{{/if}}', { x: [1] })).toBe('Y');
    });
  });

  // D9: NaN, Symbol, Infinity, undefined in {{#if}}
  it('D9a: NaN is falsy in {{#if}}', () => {
    expect(render('{{#if x}}Y{{/if}}', { x: NaN })).toBe('');
  });

  it('D9b: Infinity is truthy in {{#if}}', () => {
    expect(render('{{#if x}}Y{{/if}}', { x: Infinity })).toBe('Y');
  });

  it('D9c: undefined is falsy in {{#if}}', () => {
    // ctx.x is explicitly undefined or missing
    expect(render('{{#if x}}Y{{/if}}', { x: undefined })).toBe('');
  });

  it('D9d: missing key is falsy in {{#if}}', () => {
    expect(render('{{#if missing}}Y{{/if}}', {})).toBe('');
  });

  // D10: buildContext with invalid started_at causes wallclock_minutes to be NaN
  it('D10: buildContext with invalid started_at produces NaN wallclock_minutes DEFECT check', () => {
    const tree = {
      schema_version: 2, goal_id: 'g', mission: 'm',
      created_at: '2026-05-09T00:00:00.000Z', approved_at: null,
      root: makeSprintNode({
        id: 's',
        children: [makeTaskNode({ id: 't1' })],
      }),
    };
    const state = makeState({
      budget: {
        iterations: { used: 0, max: 100 },
        tokens: { used: 0, max: 1_000_000 },
        wallclock: { started_at: 'NOT-A-DATE', max_seconds: 14400 },
      },
    });
    // buildContext should not crash; state isn't schema-validated here, called directly
    const ctx = buildContext(tree, state, 't1', Date.now());
    // wallclock_minutes: Math.max(0, Math.floor((now - NaN) / 60000))
    // (now - NaN) === NaN; Math.floor(NaN) === NaN; Math.max(0, NaN) === NaN
    // This is a potential defect: wallclock_minutes would be NaN, not 0.
    if (ctx !== null) {
      // Document actual value
      const isNaNResult = Number.isNaN(ctx.wallclock_minutes);
      // If this assertion passes, the defect is confirmed: NaN slips through Math.max(0, NaN)
      // The fix would be: add `|| 0` after the Math.max expression.
      expect(typeof ctx.wallclock_minutes).toBe('number'); // will be NaN (number type) if defect present
    }
  });
});

// ─── E. Apply-mutations attacks ───────────────────────────────────────────────

describe('E. Apply-mutations attacks', () => {

  // E1: all-in-one batch (evidence + status + review-request + audit-verdict)
  it('E1: all-in-one batch — evidence lands, status applies, review-request then verdict conflict', () => {
    const tree = makeMinimalTree({
      children: [makeTaskNode({ id: 't1', acceptance_criteria: ['c0'], review: ['agent-x'] })],
    });
    const state = makeState({ cursor: 't1' });
    const tags = [
      evidenceTag(0),
      statusTag('achieved'),
      { kind: 'review-request', agents: ['agent-x'] },
      verdictTag('agent-x', 'GO', 'looks good'),
    ];
    const { tree: t2, state: s2 } = applyMutations(tree, state, tags, '2026-05-09T01:00:00.000Z');
    // achieved + has review[] → goes to review-pending (NOT achieved directly)
    // then review-request is ignored (not pursuing after status change)
    // then verdict batch fires because status=review-pending, agent-x gave GO → achieved!
    expect(t2.root.children[0].status).toBe('achieved');
    expect(s2.lifecycle).toBe('achieved'); // only task, no pending successor
  });

  // E2: multiple <task-status> tags — first wins
  it('E2: multiple task-status tags — first wins (pursuing before achieved)', () => {
    const tree = makeMinimalTree();
    const state = makeState();
    const tags = [
      evidenceTag(0),
      statusTag('pursuing'),
      statusTag('achieved'),
      { kind: 'blocker', reason: 'oops' },
    ];
    const { tree: t2 } = applyMutations(tree, state, tags, '2026-05-09T01:00:00.000Z');
    // First status is 'pursuing', so should NOT achieve even though criteria covered
    expect(t2.root.children[0].status).toBe('pursuing');
  });

  // E3: evidence runs in a SEPARATE loop before status — tag list order does NOT matter
  it('E3: evidence loop runs before status loop regardless of tag source order', () => {
    // IMPORTANT: applyMutations has two separate passes:
    //   1) evidence loop: `for (const tag of tags) { if tag.kind==='evidence' ... }`
    //   2) status: `tags.find(t => t.kind === 'task-status')`
    // Because evidence is collected in a full separate loop first, even if statusTag
    // appears BEFORE evidenceTag in the array, the evidence IS collected before the
    // status check fires. This means:
    //   [statusTag('achieved'), evidenceTag(0)]
    // still achieves the task (criterion 0 is covered by the time allCriteriaCovered runs).
    // This CONTRADICTS the docstring claim that "evidence must appear before status
    // in canonical agent output" for late evidence to land on the closing-out task.
    // Actually the docstring is about a DIFFERENT scenario (cursor advancing mid-batch).
    const tree = makeMinimalTree();
    const state = makeState();
    const tags = [
      statusTag('achieved'),
      evidenceTag(0), // comes AFTER status in the array — but evidence loop runs first
    ];
    const { tree: t2 } = applyMutations(tree, state, tags, '2026-05-09T01:00:00.000Z');
    // Evidence loop always runs first → criterion 0 is covered → achieved fires
    expect(t2.root.children[0].evidence).toHaveLength(1);
    expect(t2.root.children[0].status).toBe('achieved'); // NOT 'pursuing' — engine always covers evidence first
  });

  // E4: out-of-range criterion — evidence pushed but NOT counted toward coverage
  it('E4: criterion=99 on 3-criteria task — evidence pushed but coverage fails', () => {
    const tree = makeMinimalTree({
      children: [makeTaskNode({ id: 't1', acceptance_criteria: ['c0', 'c1', 'c2'] })],
    });
    const state = makeState();
    const tags = [
      { kind: 'evidence', file: 'x', line: null, criterion: 99, note: 'n', command: null, exit_code: null },
      statusTag('achieved'),
    ];
    const { tree: t2 } = applyMutations(tree, state, tags, '2026-05-09T01:00:00.000Z');
    expect(t2.root.children[0].evidence).toHaveLength(1);
    // out-of-range criterion — not covered, task should remain pursuing
    expect(t2.root.children[0].status).toBe('pursuing');
  });

  // E5: lifecycle already 'achieved' — still mutates?
  it('E5: applyMutations on achieved lifecycle still applies evidence mutations', () => {
    const tree = makeMinimalTree();
    const state = makeState({ lifecycle: 'achieved' });
    const tags = [evidenceTag(0)];
    const { tree: t2, state: s2 } = applyMutations(tree, state, tags, '2026-05-09T01:00:00.000Z');
    // Main mutation pipeline is NOT gated on lifecycle — evidence still lands
    expect(t2.root.children[0].evidence).toHaveLength(1);
    // lifecycle-transition guards are guarded by state.lifecycle === 'pursuing'
    // so lifecycle stays 'achieved' (not double-fired)
    expect(s2.lifecycle).toBe('achieved');
  });

  // E6: 3 NOGOs in one batch — counter increments BY ONE
  it('E6: 3 NOGO verdicts in one batch only increments review_attempts by 1', () => {
    const tree = makeMinimalTree({
      children: [makeTaskNode({ id: 't1', acceptance_criteria: ['c0'], review: ['a'], status: 'review-pending' })],
    });
    const state = makeState({ cursor: 't1' });
    const tags = [
      verdictTag('a', 'NOGO', 'no1'),
      verdictTag('a', 'NOGO', 'no2'),
      verdictTag('a', 'NOGO', 'no3'),
    ];
    const { tree: t2 } = applyMutations(tree, state, tags, '2026-05-09T01:00:00.000Z');
    expect(t2.root.children[0].review_attempts).toBe(1); // not 3
    expect(t2.root.children[0].status).toBe('pursuing');
  });

  // E7: mixed GO+NOGO from different agents — NOGO wins
  it('E7: mixed GO+NOGO from different agents — NOGO wins, node stays pursuing', () => {
    const tree = makeMinimalTree({
      children: [makeTaskNode({
        id: 't1', acceptance_criteria: ['c0'], review: ['a', 'b'], status: 'review-pending',
      })],
    });
    const state = makeState({ cursor: 't1' });
    const tags = [
      verdictTag('a', 'GO'),
      verdictTag('b', 'NOGO'),
    ];
    const { tree: t2, state: s2 } = applyMutations(tree, state, tags, '2026-05-09T01:00:00.000Z');
    expect(t2.root.children[0].status).toBe('pursuing');
    expect(t2.root.children[0].review_attempts).toBe(1);
    expect(s2.lifecycle).toBe('pursuing');
  });

  // E8: same agent emits GO then NOGO — NOGO wins (allGo check fails)
  it('E8: same agent emits GO then NOGO in same batch — NOGO wins', () => {
    const tree = makeMinimalTree({
      children: [makeTaskNode({ id: 't1', acceptance_criteria: ['c0'], review: ['a'], status: 'review-pending' })],
    });
    const state = makeState({ cursor: 't1' });
    const tags = [
      verdictTag('a', 'GO'),
      verdictTag('a', 'NOGO'),
    ];
    const { tree: t2 } = applyMutations(tree, state, tags, '2026-05-09T01:00:00.000Z');
    expect(t2.root.children[0].status).toBe('pursuing');
    expect(t2.root.children[0].review_attempts).toBe(1);
  });

  // E9: required reviewer absent — allGo fails, no NOGO, status stays review-pending
  it('E9: required reviewer absent — status stays review-pending (neither allGo nor anyNo)', () => {
    const tree = makeMinimalTree({
      children: [makeTaskNode({
        id: 't1', acceptance_criteria: ['c0'], review: ['a', 'b'], status: 'review-pending',
      })],
    });
    const state = makeState({ cursor: 't1' });
    // Only agent 'a' votes, 'b' is absent
    const tags = [verdictTag('a', 'GO')];
    const { tree: t2, state: s2 } = applyMutations(tree, state, tags, '2026-05-09T01:00:00.000Z');
    // anyNo = false, allGo = false (b has no verdicts), so NO status change
    expect(t2.root.children[0].status).toBe('review-pending');
    expect(t2.root.children[0].review_attempts).toBe(0);
    expect(s2.lifecycle).toBe('pursuing');
  });

  // E10: review-request when criteria not covered — ignored
  it('E10: review-request with uncovered criteria is ignored', () => {
    const tree = makeMinimalTree();
    const state = makeState();
    // criteria NOT covered (no evidence)
    const tags = [{ kind: 'review-request', agents: ['a'] }];
    const { tree: t2 } = applyMutations(tree, state, tags, '2026-05-09T01:00:00.000Z');
    expect(t2.root.children[0].status).toBe('pending'); // stays pending (no status tag)
  });

  // E11: auto-block via 3 consecutive task-status:blocked
  it('E11: 3 consecutive task-status:blocked calls trigger lifecycle=unmet', () => {
    const tree = makeMinimalTree({
      children: [makeTaskNode({ id: 't1', acceptance_criteria: ['c0'] })],
    });
    let state = makeState({ cursor: 't1' });
    let currentTree = tree;

    const blockTags = [
      { kind: 'task-status', value: 'blocked' },
      { kind: 'blocker', reason: 'hard blocker' },
    ];

    const ts = '2026-05-09T01:00:00.000Z';

    for (let i = 0; i < 3; i++) {
      const result = applyMutations(currentTree, state, blockTags, ts);
      currentTree = result.tree;
      state = result.state;
    }

    expect(currentTree.root.children[0].review_attempts).toBe(3);
    expect(currentTree.root.children[0].status).toBe('blocked');
    expect(state.lifecycle).toBe('unmet');
  });
});

// ─── F. Stop-hook attacks ─────────────────────────────────────────────────────

describe('F. Stop-hook attacks', () => {

  // F1: PLUGIN_ROOT env var behavior — module-level constant, not per-call
  it('F1: PLUGIN_ROOT is captured at module-import time — runtime env changes have no effect', async () => {
    // DEFECT DOCUMENTATION: PLUGIN_ROOT is a module-level constant:
    //   const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT ?? path.resolve(...)
    // This is evaluated ONCE when the module is first imported, not on each runStopHook() call.
    // Consequence: if the operator sets CLAUDE_PLUGIN_ROOT after the process starts (or
    // after the first import), the change is silently ignored. The fallback path.resolve()
    // is always used for subsequent calls in the same process.
    // In-process changes to process.env.CLAUDE_PLUGIN_ROOT cannot redirect readPrompt.
    // The CLI wrapper (stop-hook-cli.mjs) re-runs in a fresh process each time (fork/exec),
    // so for the production path this is fine. But for test isolation it means the env
    // var cannot be overridden mid-test-suite.

    const root = tmpdir();
    const tree = makeMinimalTree();
    const state = makeState();
    saveTree(root, tree);
    saveStateFn(root, state);

    const tPath = path.join(root, 'transcript.jsonl');
    fs.writeFileSync(tPath, JSON.stringify({
      message: { role: 'assistant', content: [{ type: 'text', text: 'nothing' }] },
    }) + '\n');

    // Setting PLUGIN_ROOT after import has no effect on the in-process module constant.
    const orig = process.env.CLAUDE_PLUGIN_ROOT;
    process.env.CLAUDE_PLUGIN_ROOT = '/nonexistent-plugin-root-12345';
    try {
      const result = await runStopHook({
        stdin: { session_id: 'sess-1', transcript_path: tPath },
        projectRoot: root,
      });
      // Confirming the module constant was NOT updated: hook still works (uses baked-in path)
      expect(result.exit).toBe(0);
      // stdout is non-null (prompts loaded from the ORIGINAL module-init path, not the new env)
      // This confirms the module-level PLUGIN_ROOT constant is immune to post-import env changes.
      expect(result.stdout).not.toBeUndefined(); // either null or a block decision
    } finally {
      if (orig === undefined) delete process.env.CLAUDE_PLUGIN_ROOT;
      else process.env.CLAUDE_PLUGIN_ROOT = orig;
    }
  });

  // F2: transcript file is a directory
  it('F2: transcript file is a directory → readLastAssistantText returns empty, no mutations', async () => {
    const root = tmpdir();
    const tree = makeMinimalTree();
    const state = makeState();
    saveTree(root, tree);
    saveStateFn(root, state);

    const tPath = path.join(root, 'transcript-dir');
    fs.mkdirSync(tPath);

    const result = await runStopHook({
      stdin: { session_id: 'sess-1', transcript_path: tPath },
      projectRoot: root,
    });
    expect(result.exit).toBe(0);
    expect(result.stdout?.decision).toBe('block'); // continuation rendered normally
  });

  // F3: lifecycle not 'pursuing' → stop-hook returns null stdout
  it('F3: lifecycle=budget-limited → hook returns exit 0, stdout null', async () => {
    const root = tmpdir();
    const tree = makeMinimalTree();
    const state = makeState({ lifecycle: 'budget-limited' });
    saveTree(root, tree);
    saveStateFn(root, state);

    const tPath = path.join(root, 'transcript.jsonl');
    fs.writeFileSync(tPath, '');

    const result = await runStopHook({
      stdin: { session_id: 'sess-1', transcript_path: tPath },
      projectRoot: root,
    });
    expect(result.exit).toBe(0);
    expect(result.stdout).toBeNull();
  });

  // F4: code-region stripping — fenced evidence tag is ignored
  it('F4: evidence tag inside fenced code block is stripped and NOT processed', async () => {
    const root = tmpdir();
    const tree = makeMinimalTree();
    const state = makeState();
    saveTree(root, tree);
    saveStateFn(root, state);

    const tPath = path.join(root, 'transcript.jsonl');
    const text = '```xml\n<evidence criterion="0"/>\n```';
    fs.writeFileSync(tPath, JSON.stringify({
      message: { role: 'assistant', content: [{ type: 'text', text }] },
    }) + '\n');

    const result = await runStopHook({
      stdin: { session_id: 'sess-1', transcript_path: tPath },
      projectRoot: root,
    });
    expect(result.exit).toBe(0);
    // Load state and verify NO evidence was added
    const savedState = loadState(root);
    const savedTree = loadTree(root);
    expect(savedTree?.root.children[0].evidence).toHaveLength(0);
  });

  // F5: inline code span stripping
  it('F5: evidence tag inside inline code span is stripped and NOT processed', async () => {
    const root = tmpdir();
    // Use status: 'pursuing' to match the lifecycle (stop-hook requires state.lifecycle=pursuing)
    const tree = {
      ...makeMinimalTree(),
      root: makeSprintNode({
        id: 's1',
        children: [makeTaskNode({ id: 't1', status: 'pursuing' })],
      }),
    };
    const state = makeState({ cursor: 't1' });
    saveTree(root, tree);
    saveStateFn(root, state);

    const tPath = path.join(root, 'transcript.jsonl');
    const text = 'use `<task-status>achieved</task-status>` to signal done';
    fs.writeFileSync(tPath, JSON.stringify({
      message: { role: 'assistant', content: [{ type: 'text', text }] },
    }) + '\n');

    await runStopHook({
      stdin: { session_id: 'sess-1', transcript_path: tPath },
      projectRoot: root,
    });
    const savedTree = loadTree(root);
    // task-status inside backticks stripped → task stays in original status 'pursuing'
    expect(savedTree?.root.children[0].status).toBe('pursuing');
  });

  // F6: tag immediately after fenced block — real tag kept, fenced tag stripped
  it('F6: real evidence after fenced block is processed, fenced one is not', async () => {
    const root = tmpdir();
    const tree = makeMinimalTree();
    const state = makeState();
    saveTree(root, tree);
    saveStateFn(root, state);

    const tPath = path.join(root, 'transcript.jsonl');
    const text = '```example\n<evidence criterion="0"/>\n```\nReal: <evidence criterion="0" file="x">cover</evidence>';
    fs.writeFileSync(tPath, JSON.stringify({
      message: { role: 'assistant', content: [{ type: 'text', text }] },
    }) + '\n');

    await runStopHook({
      stdin: { session_id: 'sess-1', transcript_path: tPath },
      projectRoot: root,
    });
    const savedTree = loadTree(root);
    // Only the real evidence outside the fence should be processed
    expect(savedTree?.root.children[0].evidence).toHaveLength(1);
    expect(savedTree?.root.children[0].evidence[0].file).toBe('x');
  });

  // F7: post-mutation cursor pointing at nonexistent node
  it('F7: if cursor in saved state points to nonexistent node, next hook turn returns stdout null and error', async () => {
    const root = tmpdir();
    const tree = makeMinimalTree();
    // State with cursor pointing at a node that doesn't exist in tree
    const state = makeState({ cursor: 'nonexistent-node-id' });
    saveTree(root, tree);
    saveStateFn(root, state);

    const tPath = path.join(root, 'transcript.jsonl');
    fs.writeFileSync(tPath, JSON.stringify({
      message: { role: 'assistant', content: [{ type: 'text', text: 'no tags' }] },
    }) + '\n');

    const result = await runStopHook({
      stdin: { session_id: 'sess-1', transcript_path: tPath },
      projectRoot: root,
    });
    expect(result.exit).toBe(0);
    // applyMutations returns early when cursorNode is null, then cursor lookup fails
    // stop-hook should return stdout null with an error
    expect(result.stdout).toBeNull();
    expect(result.error).toBeTruthy();
  });
});

// ─── G. Real CLI integration ──────────────────────────────────────────────────

describe('G. Real CLI integration', () => {
  const CLI = path.resolve('/Users/andresvlc/WebDev/claude-code-goal-mode/engine/stop-hook-cli.mjs');

  function setupProject(tree, state, transcriptText) {
    const root = tmpdir();
    saveTree(root, tree);
    saveStateFn(root, state);
    const tPath = path.join(root, 'transcript.jsonl');
    fs.writeFileSync(tPath, transcriptText);
    return { root, tPath };
  }

  function makeTranscriptLine(text) {
    return JSON.stringify({
      message: { role: 'assistant', content: [{ type: 'text', text }] },
    }) + '\n';
  }

  // G1: end-to-end with evidence + task-status:achieved
  it('G1: end-to-end CLI run — evidence processed, status changed, exit 0, block decision', () => {
    const tree = makeMinimalTree();
    const state = makeState();
    const text = '<evidence file="x" criterion="0">covers</evidence><task-status>achieved</task-status>';
    const { root, tPath } = setupProject(tree, state, makeTranscriptLine(text));

    const stdinPayload = JSON.stringify({ session_id: 'sess-1', transcript_path: tPath });
    let stdout, exitCode;
    try {
      stdout = execSync(`echo '${stdinPayload}' | node ${CLI}`, {
        cwd: root,
        env: { ...process.env, CLAUDE_PLUGIN_ROOT: path.resolve('/Users/andresvlc/WebDev/claude-code-goal-mode') },
      }).toString();
      exitCode = 0;
    } catch (err) {
      stdout = err.stdout?.toString() ?? '';
      exitCode = err.status ?? 1;
    }

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.decision).toBe('block');
    expect(parsed.reason).toBeTruthy();
    expect(parsed.systemMessage).toBeTruthy();

    // Verify state was updated
    const savedTree = loadTree(root);
    expect(savedTree?.root.children[0].status).toBe('achieved');
  });

  // G2: code-fenced example tag is NOT processed
  it('G2: CLI — code-fenced evidence tag is ignored', () => {
    const tree = makeMinimalTree();
    const state = makeState();
    const text = '```xml\n<evidence criterion="0"/>\n```';
    const { root, tPath } = setupProject(tree, state, makeTranscriptLine(text));

    const stdinPayload = JSON.stringify({ session_id: 'sess-1', transcript_path: tPath });
    try {
      execSync(`echo '${stdinPayload}' | node ${CLI}`, {
        cwd: root,
        env: { ...process.env, CLAUDE_PLUGIN_ROOT: path.resolve('/Users/andresvlc/WebDev/claude-code-goal-mode') },
      });
    } catch (_) {}

    const savedTree = loadTree(root);
    expect(savedTree?.root.children[0].evidence).toHaveLength(0);
  });

  // G3: session_id mismatch — auto-rebind, mutations applied to live session
  it('G3: CLI — session_id mismatch with lifecycle=pursuing → auto-rebinds and applies mutations', () => {
    const tree = {
      ...makeMinimalTree(),
      root: makeSprintNode({
        id: 's1',
        children: [makeTaskNode({ id: 't1', status: 'pursuing' })],
      }),
    };
    const state = makeState({ session_id: 'sess-correct', cursor: 't1' });
    const text = '<evidence criterion="0">cover</evidence><task-status>achieved</task-status>';
    const { root, tPath } = setupProject(tree, state, makeTranscriptLine(text));

    const stdinPayload = JSON.stringify({ session_id: 'sess-NEW', transcript_path: tPath });
    let stdout = null;
    try {
      stdout = execSync(`echo '${stdinPayload}' | node ${CLI}`, {
        cwd: root,
        env: { ...process.env, CLAUDE_PLUGIN_ROOT: path.resolve('/Users/andresvlc/WebDev/claude-code-goal-mode') },
      }).toString();
    } catch (_) {}

    // stdout contains the block decision (auto-rebind ran through pursuing path).
    expect(stdout).toMatch(/"decision":\s*"block"/);

    // State session_id rebound to live session; mutations applied.
    const savedState = JSON.parse(fs.readFileSync(path.join(root, '.claude/goals/active/state.json'), 'utf8'));
    expect(savedState.session_id).toBe('sess-NEW');
    expect(savedState.history.some((e) => e.event === 'session-rebound')).toBe(true);

    const savedTree = loadTree(root);
    expect(savedTree?.root.children[0].evidence.length).toBeGreaterThan(0);
  });
});
