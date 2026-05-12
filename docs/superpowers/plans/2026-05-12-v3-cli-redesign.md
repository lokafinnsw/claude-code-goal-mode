# goal-mode v3.0 — CLI-first Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate the Stop-hook driver antipattern. Make goal-mode a CLI-first tool that an agent (or human) drives explicitly via slash-commands and CLI verbs, while preserving every v2.0.6 invariant (plan-tree schema, event log, reviewer-independence, triple budget). Stop-hook becomes hint-only by default (null stdout on `lifecycle=pursuing`), with the legacy driver still available as opt-in via `stopHookDriver: true` config.

**Architecture:**

```
┌─────────────────────────────────────────────────────────┐
│             CORE (unchanged — every v2.0.6 invariant)    │
│   tree.json + state.json + event log + reducer + lock   │
│   ADR-0001 (event-sourcing) · ADR-0002 (file locking)   │
└─────────────────────────────────────────────────────────┘
        ↑                  ↑                    ↑
        │                  │                    │
┌──────────────┐  ┌─────────────────┐  ┌──────────────────┐
│ CLI verbs    │  │ Slash commands  │  │  Stop-hook       │
│ (existing +  │  │ (existing +     │  │  (HINT-ONLY by   │
│  new in v3)  │  │  new in v3)     │  │   default)       │
│              │  │                 │  │                  │
│ goal-mode    │  │ /goal-mode:     │  │  Returns null    │
│  evidence-   │  │  evidence-add   │  │  on pursuing     │
│   add        │  │  achieve        │  │  unless          │
│  achieve     │  │  current        │  │  stopHookDriver  │
│  current     │  │  submit-verdict │  │  =true.          │
│  submit-     │  │  review-request │  │                  │
│   verdict    │  │  as-builtin     │  │  SessionStart    │
│  review-     │  │                 │  │  hint preserved  │
│   request    │  │                 │  │  (paused /       │
│  as-builtin  │  │                 │  │   awaiting /     │
│              │  │                 │  │   blocked).      │
└──────────────┘  └─────────────────┘  └──────────────────┘
        ↑
        │ optional bridge to built-in /goal:
        │
┌────────────────────────────────────────────────────────┐
│  goal current --as-builtin → text suitable for piping  │
│  into Claude Code's built-in /goal command (drives      │
│  the loop via Anthropic's Haiku evaluator while         │
│  goal-mode tracks structure + reviewers + budget).      │
└────────────────────────────────────────────────────────┘
```

**Tech Stack:** Node.js ≥20, ESM, zod, vitest. No new runtime deps — every v3 addition reuses existing engine modules. ESLint-style style consistency with the rest of the repo (cf. ANTI-PATTERNS.md).

**Backward compatibility:** v2.x state files load unchanged (`schema_version: 2` preserved). Legacy tag-emission path (`<evidence>`, `<task-status>`, `<audit-verdict>`) keeps working under `stopHookDriver: true`. v2 → v3 upgrade is a no-op for the user's state; only behavior changes.

**Non-goals (defer to v3.1+):**
- Per-session silent counter (the goal-scoped counter from v2.0.6 stays).
- Migration to TypeScript (not justified by tech-debt math).
- Replacing zod with a leaner validator.
- Removing `parse-tags.mjs` (legacy driver still depends on it).

---

## Sprint 1 — New CLI verbs (foundation)

The agent should be able to advance cursor state without emitting tags inside its assistant reply. These verbs invoke `applyMutations()` (the same pure mutator the Stop-hook uses) with synthetic tag streams.

### Task 1.1: Core function — `evidenceAdd()`

**Files:**
- Create: `engine/evidence-add.mjs`
- Test: `tests/evidence-add.test.mjs`

Wraps `applyMutations()` with a single `evidence` tag (file/line OR command/exit_code variant). Preconditions: state exists, cursor in tree, `lifecycle === 'pursuing'`, cursor.status in `{pursuing, review-pending}`. Returns `{ ok, evidence_count, message }`. Acquires `withLockSync` around the read-mutate-write triplet.

- [ ] **Step 1: Write the failing test**

`tests/evidence-add.test.mjs`:
```js
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { evidenceAdd } from '../engine/evidence-add.mjs';
import { saveState, saveTree, loadState, loadTree } from '../engine/state.mjs';
import { activeDir } from '../engine/paths.mjs';

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-evadd-'));
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
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('rejects when lifecycle !== pursuing', () => {
    const root = setup();
    const st = loadState(root);
    st.lifecycle = 'paused';
    saveState(root, st);
    const r = evidenceAdd(root, { criterion: 0, file: 'f', note: '' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/lifecycle/);
    fs.rmSync(root, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/evidence-add.test.mjs`
Expected: FAIL with `Cannot find module '../engine/evidence-add.mjs'`.

- [ ] **Step 3: Write minimal implementation**

`engine/evidence-add.mjs`:
```js
/**
 * Pure-function core of /goal-mode:evidence-add.
 *
 * Synthesizes a single `evidence` tag and dispatches to applyMutations.
 * The agent uses this to write evidence to the cursor node WITHOUT
 * emitting <evidence/> tags in the assistant reply — the v3.0 explicit
 * CLI path bypasses the parse-tags layer entirely.
 *
 * Preconditions:
 *   1. state.json exists.
 *   2. tree.json exists.
 *   3. state.cursor matches a node in tree.
 *   4. state.lifecycle === 'pursuing'.
 *   5. cursor.status in {'pursuing', 'review-pending'}.
 *
 * Inputs: { criterion?: int, file?: string, line?: int, command?: string,
 *           exit_code?: int, note?: string }
 *
 * Returns: { ok, evidence_count?, error? }
 */
import { loadTree, loadState, saveTree, saveState } from './state.mjs';
import { findNodeById } from './traversal.mjs';
import { applyMutations } from './apply-mutations.mjs';
import { activeDir } from './paths.mjs';
import { withLockSync } from './lock.mjs';

export function evidenceAdd(projectRoot, opts) {
  return withLockSync(activeDir(projectRoot), 'evidence-add', {}, () => {
    const state = loadState(projectRoot);
    if (!state) return { ok: false, error: 'no active goal' };
    if (state.lifecycle !== 'pursuing') {
      return { ok: false, error: `cannot add evidence from lifecycle=${state.lifecycle}` };
    }
    const tree = loadTree(projectRoot);
    if (!tree) return { ok: false, error: 'no tree.json' };
    const cursor = findNodeById(tree, state.cursor);
    if (!cursor) return { ok: false, error: `cursor ${state.cursor} not in tree` };
    if (cursor.status !== 'pursuing' && cursor.status !== 'review-pending') {
      return { ok: false, error: `cursor.status=${cursor.status}; expected pursuing or review-pending` };
    }

    const ts = new Date().toISOString();
    const tag = {
      kind: 'evidence',
      criterion: opts.criterion ?? null,
      file: opts.file ?? null,
      line: opts.line ?? null,
      command: opts.command ?? null,
      exit_code: opts.exit_code ?? null,
      note: opts.note ?? '',
    };
    const { tree: tree2, state: state2 } = applyMutations(tree, state, [tag], ts);
    saveTree(projectRoot, tree2);
    saveState(projectRoot, state2);
    const updated = findNodeById(tree2, state.cursor);
    return { ok: true, evidence_count: updated.evidence.length };
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/evidence-add.test.mjs`
Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add engine/evidence-add.mjs tests/evidence-add.test.mjs
git commit -m "feat(v3): evidenceAdd() core — explicit CLI path for evidence collection"
```

---

### Task 1.2: CLI wrapper — `evidence-add-cli.mjs`

**Files:**
- Create: `engine/evidence-add-cli.mjs`
- Test: `tests/evidence-add-cli.test.mjs`

Parses `--criterion N --file path[:line] --note "..."` (file-based) OR `--criterion N --command "cmd" --exit-code N --note "..."` (shell-based). Exit codes: 0 ok, 1 precondition failure, 2 bad CLI args. Prints structured stdout on success: `✅ evidence #<N> added to cursor <node-id>`.

- [ ] **Step 1: Write the failing test**

`tests/evidence-add-cli.test.mjs`:
```js
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { saveState, saveTree } from '../engine/state.mjs';
import { activeDir } from '../engine/paths.mjs';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'engine', 'evidence-add-cli.mjs');

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-evcli-'));
  fs.mkdirSync(activeDir(root), { recursive: true });
  saveTree(root, /* same as 1.1 */);
  saveState(root, /* same as 1.1 */);
  return root;
}

describe('evidence-add-cli', () => {
  it('exits 0 with file-based evidence', () => {
    const root = setup();
    const r = spawnSync('node', [CLI, '--criterion', '0', '--file', 'src/foo.ts:42', '--note', 'proof'], { cwd: root });
    expect(r.status).toBe(0);
    expect(r.stdout.toString()).toMatch(/evidence #1 added/);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('exits 2 on missing --criterion', () => {
    const root = setup();
    const r = spawnSync('node', [CLI, '--file', 'src/foo.ts'], { cwd: root });
    expect(r.status).toBe(2);
    fs.rmSync(root, { recursive: true, force: true });
  });
});
```

(Re-use the same `setup()` body as Task 1.1 — DRY only across same file.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/evidence-add-cli.test.mjs`
Expected: FAIL — CLI doesn't exist.

- [ ] **Step 3: Write minimal implementation**

`engine/evidence-add-cli.mjs`:
```js
#!/usr/bin/env node
/**
 * /goal-mode:evidence-add CLI wrapper.
 *
 * Args:
 *   --criterion N           (required, int ≥ 0)
 *   --file path[:line]      (file-based; line optional, parsed from suffix)
 *   --command "cmd"         (shell-based)
 *   --exit-code N           (shell-based)
 *   --note "text"           (optional, default empty)
 *
 * Exactly one of {--file, --command} must be supplied.
 */
import { evidenceAdd } from './evidence-add.mjs';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--criterion') out.criterion = Number(argv[++i]);
    else if (a === '--file') out.file = argv[++i];
    else if (a === '--line') out.line = Number(argv[++i]);
    else if (a === '--command') out.command = argv[++i];
    else if (a === '--exit-code') out.exit_code = Number(argv[++i]);
    else if (a === '--note') out.note = argv[++i];
    else { console.error(`Unknown arg: ${a}`); process.exit(2); }
  }
  if (!Number.isInteger(out.criterion) || out.criterion < 0) {
    console.error('--criterion <int ≥ 0> required'); process.exit(2);
  }
  const hasFile = typeof out.file === 'string';
  const hasCmd = typeof out.command === 'string';
  if (!hasFile && !hasCmd) {
    console.error('one of --file or --command required'); process.exit(2);
  }
  if (hasFile && out.file.includes(':')) {
    const [f, l] = out.file.split(':');
    out.file = f;
    if (!Number.isNaN(Number(l))) out.line = out.line ?? Number(l);
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const opts = parseArgs(process.argv.slice(2));
  const r = evidenceAdd(process.cwd(), opts);
  if (!r.ok) {
    console.error(`❌ ${r.error}`);
    process.exit(1);
  }
  console.log(`✅ evidence #${r.evidence_count} added to cursor`);
}
```

`chmod +x engine/evidence-add-cli.mjs`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/evidence-add-cli.test.mjs`
Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
chmod +x engine/evidence-add-cli.mjs
git add engine/evidence-add-cli.mjs tests/evidence-add-cli.test.mjs
git commit -m "feat(v3): evidence-add-cli — thin CLI over evidenceAdd()"
```

---

### Task 1.3: Core function — `achieveCursor()`

**Files:**
- Create: `engine/achieve.mjs`
- Test: `tests/achieve.test.mjs`

Claims achievement on cursor. Validates all ACs covered. If `review[]` empty → marks achieved + advances. Else → transitions to `review-pending`. Returns `{ ok, status, missing_criteria?, next_cursor?, error? }`. The "happy path" outcomes match what `<task-status>achieved</task-status>` emits via `applyMutations`.

- [ ] **Step 1: Write the failing test**

`tests/achieve.test.mjs`:
```js
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { achieveCursor } from '../engine/achieve.mjs';
import { evidenceAdd } from '../engine/evidence-add.mjs';
import { saveState, saveTree, loadState, loadTree } from '../engine/state.mjs';
import { activeDir } from '../engine/paths.mjs';

function setup({ review = [] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-ach-'));
  fs.mkdirSync(activeDir(root), { recursive: true });
  saveTree(root, {
    schema_version: 2, goal_id: 'g', mission: 'm',
    created_at: '2026-05-12T00:00:00.000Z',
    approved_at: '2026-05-12T00:00:00.000Z',
    root: {
      id: 's', type: 'sprint', title: 'S', goal: 'g', acceptance_criteria: [],
      review: [], validate: null, work_front: null, status: 'pursuing',
      evidence: [], blocker_reason: null, review_attempts: 0, notes: [],
      children: [
        { id: 't1', type: 'task', title: 't1', goal: 'g1',
          acceptance_criteria: ['c0', 'c1'], review, validate: null,
          work_front: null, status: 'pursuing', evidence: [],
          blocker_reason: null, review_attempts: 0, notes: [], children: [] },
        { id: 't2', type: 'task', title: 't2', goal: 'g2',
          acceptance_criteria: ['c0'], review: [], validate: null,
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

describe('achieveCursor', () => {
  it('rejects when not all ACs covered (lists missing)', () => {
    const root = setup();
    evidenceAdd(root, { criterion: 0, file: 'a', note: '' });
    const r = achieveCursor(root);
    expect(r.ok).toBe(false);
    expect(r.missing_criteria).toEqual([1]);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('with empty review[]: marks achieved + advances cursor', () => {
    const root = setup({ review: [] });
    evidenceAdd(root, { criterion: 0, file: 'a', note: '' });
    evidenceAdd(root, { criterion: 1, file: 'b', note: '' });
    const r = achieveCursor(root);
    expect(r.ok).toBe(true);
    expect(r.status).toBe('achieved');
    expect(r.next_cursor).toBe('t2');
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('with non-empty review[]: transitions to review-pending', () => {
    const root = setup({ review: ['aaa-art-director'] });
    evidenceAdd(root, { criterion: 0, file: 'a', note: '' });
    evidenceAdd(root, { criterion: 1, file: 'b', note: '' });
    const r = achieveCursor(root);
    expect(r.ok).toBe(true);
    expect(r.status).toBe('review-pending');
    expect(r.required_reviewers).toEqual(['aaa-art-director']);
    fs.rmSync(root, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/achieve.test.mjs`
Expected: FAIL — `achieve.mjs` missing.

- [ ] **Step 3: Write minimal implementation**

`engine/achieve.mjs`:
```js
/**
 * Pure-function core of /goal-mode:achieve.
 *
 * Validates all ACs covered, then synthesizes a <task-status>achieved</>
 * tag and dispatches to applyMutations. Mirrors the legacy tag-emission
 * path while removing the requirement to emit XML in the assistant reply.
 *
 * Returns:
 *   { ok: true, status: 'achieved'|'review-pending',
 *     next_cursor?, required_reviewers? }
 *   { ok: false, missing_criteria: [int...], error?: string }
 */
import { loadTree, loadState, saveTree, saveState } from './state.mjs';
import { findNodeById } from './traversal.mjs';
import { applyMutations } from './apply-mutations.mjs';
import { activeDir } from './paths.mjs';
import { withLockSync } from './lock.mjs';

export function achieveCursor(projectRoot) {
  return withLockSync(activeDir(projectRoot), 'achieve', {}, () => {
    const state = loadState(projectRoot);
    if (!state) return { ok: false, error: 'no active goal' };
    if (state.lifecycle !== 'pursuing') {
      return { ok: false, error: `cannot achieve from lifecycle=${state.lifecycle}` };
    }
    const tree = loadTree(projectRoot);
    if (!tree) return { ok: false, error: 'no tree.json' };
    const cursor = findNodeById(tree, state.cursor);
    if (!cursor) return { ok: false, error: `cursor ${state.cursor} not in tree` };

    // Compute missing criteria BEFORE invoking applyMutations so the caller
    // gets a clear error rather than a silent no-op (applyMutations's
    // allCriteriaCovered check returns false and the status tag falls through
    // to a `cursor.status='pursuing'` no-op, which is correct semantics but
    // unhelpful UX for an explicit CLI invocation).
    const covered = new Set();
    for (const ev of cursor.evidence) {
      if (ev.criterion_index !== null && ev.criterion_index >= 0 &&
          ev.criterion_index < cursor.acceptance_criteria.length) {
        covered.add(ev.criterion_index);
      }
    }
    const missing = [];
    for (let i = 0; i < cursor.acceptance_criteria.length; i++) {
      if (!covered.has(i)) missing.push(i);
    }
    if (missing.length > 0) {
      return { ok: false, missing_criteria: missing };
    }

    const ts = new Date().toISOString();
    const tag = { kind: 'task-status', value: 'achieved' };
    const { tree: tree2, state: state2 } = applyMutations(tree, state, [tag], ts);
    saveTree(projectRoot, tree2);
    saveState(projectRoot, state2);

    const newCursorNode = findNodeById(tree2, cursor.id);
    if (newCursorNode.status === 'achieved') {
      return { ok: true, status: 'achieved', next_cursor: state2.cursor };
    }
    if (newCursorNode.status === 'review-pending') {
      return {
        ok: true, status: 'review-pending',
        required_reviewers: [...cursor.review],
      };
    }
    return { ok: false, error: `unexpected post-achieve status: ${newCursorNode.status}` };
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/achieve.test.mjs`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add engine/achieve.mjs tests/achieve.test.mjs
git commit -m "feat(v3): achieveCursor() core — explicit CLI achievement path"
```

---

### Task 1.4: CLI wrapper — `achieve-cli.mjs`

**Files:**
- Create: `engine/achieve-cli.mjs`
- Test: `tests/achieve-cli.test.mjs`

Args: none (operates on current cursor). Exit codes: 0 achieved or review-pending, 1 missing-criteria (lists them in stderr), 2 precondition failure. Prints JSON-like summary on stdout: `✅ achieved → next cursor: <id>` or `🔵 review-pending → reviewers required: aaa-art-director`.

- [ ] **Step 1: Write the failing test**

`tests/achieve-cli.test.mjs`:
```js
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { saveState, saveTree } from '../engine/state.mjs';
import { activeDir } from '../engine/paths.mjs';
import { evidenceAdd } from '../engine/evidence-add.mjs';

const ROOT_DIR = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(ROOT_DIR, '..', 'engine', 'achieve-cli.mjs');

function setup({ review = [] } = {}) { /* repeat from Task 1.3 */ }

describe('achieve-cli', () => {
  it('exits 1 with missing-criteria list on stderr', () => {
    const root = setup();
    const r = spawnSync('node', [CLI], { cwd: root });
    expect(r.status).toBe(1);
    expect(r.stderr.toString()).toMatch(/missing/i);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('exits 0 with achieved message on stdout', () => {
    const root = setup();
    evidenceAdd(root, { criterion: 0, file: 'a' });
    evidenceAdd(root, { criterion: 1, file: 'b' });
    const r = spawnSync('node', [CLI], { cwd: root });
    expect(r.status).toBe(0);
    expect(r.stdout.toString()).toMatch(/achieved/);
    fs.rmSync(root, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/achieve-cli.test.mjs`
Expected: FAIL — CLI missing.

- [ ] **Step 3: Write minimal implementation**

`engine/achieve-cli.mjs`:
```js
#!/usr/bin/env node
import { achieveCursor } from './achieve.mjs';

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = achieveCursor(process.cwd());
  if (!r.ok) {
    if (r.missing_criteria) {
      console.error(`❌ missing evidence for criteria: ${r.missing_criteria.join(', ')}`);
      process.exit(1);
    }
    console.error(`❌ ${r.error}`);
    process.exit(2);
  }
  if (r.status === 'achieved') {
    console.log(`✅ achieved → next cursor: ${r.next_cursor}`);
  } else {
    console.log(`🔵 review-pending → reviewers required: ${r.required_reviewers.join(', ')}`);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/achieve-cli.test.mjs`
Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
chmod +x engine/achieve-cli.mjs
git add engine/achieve-cli.mjs tests/achieve-cli.test.mjs
git commit -m "feat(v3): achieve-cli — thin CLI over achieveCursor()"
```

---

### Task 1.5: Core function — `submitVerdict()`

**Files:**
- Create: `engine/submit-verdict.mjs`
- Test: `tests/submit-verdict.test.mjs`

Used after the agent has dispatched a reviewer via `Agent({subagent_type:...})` and collected the verdict. Synthesizes one `audit-verdict` tag and runs `applyMutations`. The function MUST pass `opts.scannedAgents` so the reviewer-independence guard fires when the agent didn't actually dispatch the named reviewer. The CLI wrapper (Task 1.6) populates `scannedAgents` by re-scanning the current session transcript via `scanAgentInvocations` (existing function in `transcript.mjs`).

- [ ] **Step 1: Write the failing test**

`tests/submit-verdict.test.mjs`:
```js
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { submitVerdict } from '../engine/submit-verdict.mjs';
import { saveState, saveTree, loadState, loadTree } from '../engine/state.mjs';
import { activeDir } from '../engine/paths.mjs';

function setup({ status = 'review-pending', review = ['aaa-art-director'] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-verd-'));
  fs.mkdirSync(activeDir(root), { recursive: true });
  saveTree(root, {
    schema_version: 2, goal_id: 'g', mission: 'm',
    created_at: '2026-05-12T00:00:00.000Z',
    approved_at: '2026-05-12T00:00:00.000Z',
    root: {
      id: 's', type: 'sprint', title: 'S', goal: 'g', acceptance_criteria: [],
      review: [], validate: null, work_front: null, status: 'pursuing',
      evidence: [], blocker_reason: null, review_attempts: 0, notes: [],
      children: [
        { id: 't1', type: 'task', title: 't1', goal: 'g1',
          acceptance_criteria: ['c0'], review, validate: null,
          work_front: null, status, evidence: [
            { ts: '2026-05-12T00:00:00.000Z', iteration: 1, criterion_index: 0,
              file: 'f', line: null, commit: null, command: null,
              exit_code: null, note: '' },
          ],
          blocker_reason: null, review_attempts: 0, notes: [], children: [] },
        { id: 't2', type: 'task', title: 't2', goal: 'g2',
          acceptance_criteria: ['c0'], review: [], validate: null,
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

describe('submitVerdict', () => {
  it('GO verdict from a dispatched reviewer advances cursor', () => {
    const root = setup();
    const r = submitVerdict(root, {
      agent: 'aaa-art-director', status: 'GO', text: 'looks good',
      scannedAgents: new Set(['aaa-art-director']),
    });
    expect(r.ok).toBe(true);
    expect(r.next_cursor).toBe('t2');
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('GO verdict from un-dispatched reviewer is REJECTED', () => {
    const root = setup();
    const r = submitVerdict(root, {
      agent: 'aaa-art-director', status: 'GO', text: 'looks good',
      scannedAgents: new Set(), // empty: reviewer wasn't dispatched
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/independence/);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('escape-hatch (REVISE + unavailable) transitions to awaiting-manual-approval', () => {
    const root = setup();
    const r = submitVerdict(root, {
      agent: 'aaa-art-director', status: 'REVISE', text: 'unavailable; user must run /goal-approve',
      scannedAgents: new Set(),
    });
    const st = loadState(root);
    expect(r.ok).toBe(true);
    expect(st.lifecycle).toBe('awaiting-manual-approval');
    fs.rmSync(root, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/submit-verdict.test.mjs`
Expected: FAIL.

- [ ] **Step 3: Write minimal implementation**

`engine/submit-verdict.mjs`:
```js
/**
 * Pure-function core of /goal-mode:submit-verdict.
 *
 * Used after the agent dispatches a reviewer subagent via Agent() and
 * collects its verdict (GO/NOGO/REVISE). Routes through applyMutations
 * with opts.scannedAgents so reviewer-independence enforcement (and the
 * escape-hatch detector) still fires.
 *
 * Returns:
 *   - { ok: true, next_cursor?, status: 'achieved'|'review-pending'|'blocked' }
 *   - { ok: false, error }   when the verdict is rejected (no dispatch
 *                            detected and not an escape-hatch).
 */
import { loadTree, loadState, saveTree, saveState } from './state.mjs';
import { findNodeById } from './traversal.mjs';
import { applyMutations } from './apply-mutations.mjs';
import { activeDir, auditsDir } from './paths.mjs';
import { withLockSync } from './lock.mjs';

export function submitVerdict(projectRoot, opts) {
  if (!opts.agent || !opts.status) {
    return { ok: false, error: 'agent and status required' };
  }
  if (!['GO', 'NOGO', 'REVISE'].includes(opts.status)) {
    return { ok: false, error: `invalid status ${opts.status}` };
  }
  if (!(opts.scannedAgents instanceof Set)) {
    return { ok: false, error: 'scannedAgents Set required' };
  }
  return withLockSync(activeDir(projectRoot), 'submit-verdict', {}, () => {
    const state = loadState(projectRoot);
    if (!state) return { ok: false, error: 'no active goal' };
    if (state.lifecycle !== 'pursuing') {
      return { ok: false, error: `cannot submit verdict from lifecycle=${state.lifecycle}` };
    }
    const tree = loadTree(projectRoot);
    const cursor = findNodeById(tree, state.cursor);
    if (cursor.status !== 'review-pending') {
      return { ok: false, error: `cursor not review-pending (is ${cursor.status})` };
    }

    const tag = {
      kind: 'audit-verdict',
      agent: opts.agent,
      status: opts.status,
      text: opts.text ?? '',
    };
    const ts = new Date().toISOString();
    const { tree: tree2, state: state2 } = applyMutations(
      tree, state, [tag], ts,
      { scannedAgents: opts.scannedAgents, auditsDir: auditsDir(projectRoot) },
    );

    // Detect rejection: history entry with rejected=true was added.
    const newEvents = state2.history.slice(state.history.length);
    const rejected = newEvents.find(h => h.event === 'review-verdict' && h.payload?.rejected);
    if (rejected) {
      // Don't persist a rejected-verdict state change (it was a no-op
      // mutation on tree/state apart from the history entry, which we
      // still want for audit trail — so save it).
      saveTree(projectRoot, tree2);
      saveState(projectRoot, state2);
      return { ok: false, error: `reviewer-independence violation: ${rejected.payload.reason}` };
    }

    saveTree(projectRoot, tree2);
    saveState(projectRoot, state2);

    const c = findNodeById(tree2, cursor.id);
    return {
      ok: true,
      status: c.status,
      next_cursor: c.status === 'achieved' ? state2.cursor : undefined,
    };
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/submit-verdict.test.mjs`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add engine/submit-verdict.mjs tests/submit-verdict.test.mjs
git commit -m "feat(v3): submitVerdict() core — explicit CLI verdict path with independence guard"
```

---

### Task 1.6: CLI wrapper — `submit-verdict-cli.mjs`

**Files:**
- Create: `engine/submit-verdict-cli.mjs`
- Test: `tests/submit-verdict-cli.test.mjs`

Args: `--agent <subagent_type> --status <GO|NOGO|REVISE> --text "..."`. Reads transcript via `deriveSessionIdFromTranscript` (existing function in `start-goal-cli.mjs`) → scans agent invocations with `scanAgentInvocations` from `transcript.mjs` → populates `scannedAgents` Set. Exit codes: 0 ok, 1 rejected/escape-hatch, 2 bad args.

- [ ] **Step 1: Write the failing test**

`tests/submit-verdict-cli.test.mjs`:
```js
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { saveState, saveTree } from '../engine/state.mjs';
import { activeDir } from '../engine/paths.mjs';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'engine', 'submit-verdict-cli.mjs');

// Re-use setup from 1.5; also create a transcript file with a synthetic
// Agent() invocation for 'aaa-art-director'.

describe('submit-verdict-cli', () => {
  it('exits 2 on missing --agent', () => {
    const r = spawnSync('node', [CLI, '--status', 'GO']);
    expect(r.status).toBe(2);
  });

  it('exits 1 when reviewer not dispatched (independence violation)', () => {
    // setup with empty transcript (no Agent dispatch) ...
    // run CLI with --agent aaa-art-director --status GO ...
    // expect exit 1, stderr matches /independence/
  });
});
```

(Full test stub left for the implementer — they construct transcript via `writeFileSync`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/submit-verdict-cli.test.mjs`
Expected: FAIL (CLI missing).

- [ ] **Step 3: Write minimal implementation**

`engine/submit-verdict-cli.mjs`:
```js
#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { submitVerdict } from './submit-verdict.mjs';
import { scanAgentInvocations } from './transcript.mjs';
import { deriveSessionIdFromTranscript } from './start-goal-cli.mjs';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--agent') out.agent = argv[++i];
    else if (a === '--status') out.status = argv[++i];
    else if (a === '--text') out.text = argv[++i];
    else { console.error(`Unknown arg: ${a}`); process.exit(2); }
  }
  if (!out.agent || !out.status) {
    console.error('--agent and --status required'); process.exit(2);
  }
  return out;
}

function loadScannedAgents(cwd) {
  // Locate transcript via Claude Code's per-project dir convention.
  const sid = deriveSessionIdFromTranscript(cwd);
  if (!sid) return new Set();
  const encoded = '-' + cwd.replace(/^\//, '').replace(/\//g, '-');
  const tp = path.join(os.homedir(), '.claude', 'projects', encoded, `${sid}.jsonl`);
  if (!fs.existsSync(tp)) return new Set();
  return scanAgentInvocations(tp);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const opts = parseArgs(process.argv.slice(2));
  opts.scannedAgents = loadScannedAgents(process.cwd());
  const r = submitVerdict(process.cwd(), opts);
  if (!r.ok) {
    console.error(`❌ ${r.error}`);
    process.exit(1);
  }
  if (r.next_cursor) {
    console.log(`✅ ${r.status} → next cursor: ${r.next_cursor}`);
  } else {
    console.log(`✅ verdict recorded, cursor status: ${r.status}`);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/submit-verdict-cli.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
chmod +x engine/submit-verdict-cli.mjs
git add engine/submit-verdict-cli.mjs tests/submit-verdict-cli.test.mjs
git commit -m "feat(v3): submit-verdict-cli — verdict CLI with transcript-based independence scan"
```

---

### Task 1.7: Core function + CLI — `currentTask()`

**Files:**
- Create: `engine/current.mjs`
- Create: `engine/current-cli.mjs`
- Test: `tests/current.test.mjs`

Read-only. Returns `{ ok, cursor, task, criteria, evidence_count_per_criterion, status, required_reviewers, missing_criteria, lifecycle }`. CLI prints a human-readable summary (multiline) and can also emit `--json` for scripting and `--as-builtin` for built-in `/goal` bridge (single-line text fit for piping into `/goal "..."`).

- [ ] **Step 1: Write the failing test**

(Skipping a redundant verbose test stub — pattern matches 1.1/1.3. Cover: pursuing task with partial evidence, review-pending task, no-active-goal case.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/current.test.mjs`
Expected: FAIL.

- [ ] **Step 3: Write minimal implementation**

`engine/current.mjs`:
```js
import { loadTree, loadState } from './state.mjs';
import { findNodeById } from './traversal.mjs';

export function currentTask(projectRoot) {
  const state = loadState(projectRoot);
  if (!state) return { ok: false, error: 'no active goal' };
  const tree = loadTree(projectRoot);
  if (!tree) return { ok: false, error: 'no tree.json' };
  const cursor = findNodeById(tree, state.cursor);
  if (!cursor) return { ok: false, error: `cursor ${state.cursor} not in tree` };

  const covered = new Set();
  for (const ev of cursor.evidence) {
    if (ev.criterion_index !== null) covered.add(ev.criterion_index);
  }
  const missing = [];
  for (let i = 0; i < cursor.acceptance_criteria.length; i++) {
    if (!covered.has(i)) missing.push(i);
  }
  return {
    ok: true,
    lifecycle: state.lifecycle,
    cursor: cursor.id,
    task: {
      title: cursor.title,
      goal: cursor.goal,
      status: cursor.status,
      acceptance_criteria: cursor.acceptance_criteria,
      review: cursor.review,
      validate: cursor.validate,
      work_front: cursor.work_front,
    },
    evidence_count: cursor.evidence.length,
    missing_criteria: missing,
  };
}

export function formatHuman(r) {
  if (!r.ok) return `❌ ${r.error}`;
  const lines = [
    `Task: ${r.task.title} (${r.cursor})`,
    `Status: ${r.task.status} · Lifecycle: ${r.lifecycle}`,
    `Goal: ${r.task.goal}`,
    'Acceptance criteria:',
    ...r.task.acceptance_criteria.map((c, i) =>
      `  ${r.missing_criteria.includes(i) ? '[ ]' : '[x]'} #${i} — ${c}`),
  ];
  if (r.task.review.length) lines.push(`Reviewers required: ${r.task.review.join(', ')}`);
  if (r.task.validate) lines.push(`Validate: ${r.task.validate}`);
  return lines.join('\n');
}

export function formatAsBuiltin(r) {
  if (!r.ok) return '';
  const acStr = r.task.acceptance_criteria
    .map((c, i) => `(#${i}) ${c}`).join('; ');
  return `Goal: ${r.task.goal}. Acceptance: ${acStr}. ` +
    `Stop when all criteria have file/line evidence. ` +
    `Run /goal-mode:evidence-add per criterion, then /goal-mode:achieve.`;
}
```

`engine/current-cli.mjs`:
```js
#!/usr/bin/env node
import { currentTask, formatHuman, formatAsBuiltin } from './current.mjs';

const args = process.argv.slice(2);
const json = args.includes('--json');
const asBuiltin = args.includes('--as-builtin');
const r = currentTask(process.cwd());
if (!r.ok) {
  console.error(`❌ ${r.error}`);
  process.exit(1);
}
if (json) console.log(JSON.stringify(r, null, 2));
else if (asBuiltin) console.log(formatAsBuiltin(r));
else console.log(formatHuman(r));
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/current.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
chmod +x engine/current-cli.mjs
git add engine/current.mjs engine/current-cli.mjs tests/current.test.mjs
git commit -m "feat(v3): current-task — read-only cursor inspector + built-in /goal bridge"
```

---

### Task 1.8: Sprint 1 integration test

**Files:**
- Create: `tests/v3-cli-end-to-end.test.mjs`

End-to-end: setup goal → evidenceAdd × N → achieveCursor → submitVerdict (with synthetic transcript) → assert cursor advanced. No tags, no Stop-hook. Pure CLI verbs.

- [ ] **Step 1: Write the test**

`tests/v3-cli-end-to-end.test.mjs` (skeleton — full body uses 1.1/1.3/1.5 setup pattern):
```js
import { describe, it, expect } from 'vitest';
import { evidenceAdd } from '../engine/evidence-add.mjs';
import { achieveCursor } from '../engine/achieve.mjs';
import { submitVerdict } from '../engine/submit-verdict.mjs';

describe('v3 explicit CLI end-to-end', () => {
  it('drives a 2-task plan to completion without tags', () => {
    // setup with 2 tasks (each 1 AC), reviewer required on t1
    // evidenceAdd → achieve t1 → review-pending
    // submitVerdict GO → t2 cursor
    // evidenceAdd → achieve t2 → all achieved → lifecycle=achieved
    // assert final state
  });
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `npx vitest run tests/v3-cli-end-to-end.test.mjs`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/v3-cli-end-to-end.test.mjs
git commit -m "test(v3): end-to-end explicit CLI flow (no tags, no Stop-hook)"
```

---

## Sprint 2 — Stop-hook becomes hint-only

### Task 2.1: Plugin config schema + loader

**Files:**
- Create: `engine/plugin-config.mjs`
- Test: `tests/plugin-config.test.mjs`

Read `~/.claude/plugins/goal-mode/config.json` (per-user) and `<projectRoot>/.claude/goals/active/config.json` (per-project, overrides per-user). Schema:
```js
{
  "schema_version": 1,
  "stopHookDriver": false,         // v3 default: hint-only
  "silenceThreshold": 5            // unchanged from v2.0.6
}
```
Returns parsed config (with defaults) or default config if files missing.

- [ ] **Step 1: Write the failing test**

`tests/plugin-config.test.mjs`:
```js
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadPluginConfig } from '../engine/plugin-config.mjs';

describe('loadPluginConfig', () => {
  it('returns v3 defaults when no files exist', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-'));
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'home-'));
    const cfg = loadPluginConfig(root, { homeDir });
    expect(cfg.stopHookDriver).toBe(false);
    expect(cfg.silenceThreshold).toBe(5);
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  it('per-project overrides per-user', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-'));
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'home-'));
    fs.mkdirSync(path.join(homeDir, '.claude', 'plugins', 'goal-mode'), { recursive: true });
    fs.writeFileSync(
      path.join(homeDir, '.claude', 'plugins', 'goal-mode', 'config.json'),
      JSON.stringify({ schema_version: 1, stopHookDriver: true }),
    );
    fs.mkdirSync(path.join(root, '.claude', 'goals', 'active'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.claude', 'goals', 'active', 'config.json'),
      JSON.stringify({ schema_version: 1, stopHookDriver: false }),
    );
    const cfg = loadPluginConfig(root, { homeDir });
    expect(cfg.stopHookDriver).toBe(false); // project wins
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/plugin-config.test.mjs`
Expected: FAIL.

- [ ] **Step 3: Write minimal implementation**

`engine/plugin-config.mjs`:
```js
/**
 * Plugin config loader. Per-user file at ~/.claude/plugins/goal-mode/config.json,
 * per-project file at <projectRoot>/.claude/goals/active/config.json. Project
 * keys override user keys.
 *
 * Schema (v3.0):
 *   schema_version: 1
 *   stopHookDriver: boolean (default false — v3 hint-only)
 *   silenceThreshold: int  (default 5)
 *
 * Unknown keys are preserved and returned (forward-compat with v3.1+).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULTS = Object.freeze({
  schema_version: 1,
  stopHookDriver: false,
  silenceThreshold: 5,
});

function tryReadJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

export function loadPluginConfig(projectRoot, { homeDir = os.homedir() } = {}) {
  const userCfg = tryReadJson(path.join(homeDir, '.claude', 'plugins', 'goal-mode', 'config.json'));
  const projCfg = tryReadJson(path.join(projectRoot, '.claude', 'goals', 'active', 'config.json'));
  return { ...DEFAULTS, ...(userCfg || {}), ...(projCfg || {}) };
}

export const PLUGIN_CONFIG_DEFAULTS = DEFAULTS;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/plugin-config.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add engine/plugin-config.mjs tests/plugin-config.test.mjs
git commit -m "feat(v3): plugin-config loader (user + project layering)"
```

---

### Task 2.2: Stop-hook reads config; returns null on pursuing when driver disabled

**Files:**
- Modify: `engine/stop-hook.mjs` (insert config-aware short-circuit before existing logic)
- Modify: `tests/stop-hook.test.mjs` (extend or add new test file `tests/stop-hook-v3.test.mjs`)

The current `runStopHook` (engine/stop-hook.mjs lines 116..) runs the full pipeline for `lifecycle=pursuing`. Insert a check immediately after the "state file missing" and "session_id mismatch" gates:

```js
const cfg = loadPluginConfig(projectRoot);
if (state.lifecycle === 'pursuing' && !cfg.stopHookDriver) {
  // v3 default: hint-only. Hook returns null on pursuing.
  // (Paused / awaiting-manual-approval / blocked still fall through
  //  to the existing render path, surfacing recovery hints once per
  //  session-start via the SessionStart hook.)
  return { exit: 0, stdout: null };
}
```

- [ ] **Step 1: Write the failing test**

Create `tests/stop-hook-v3.test.mjs`:
```js
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runStopHook } from '../engine/stop-hook.mjs';
import { saveState, saveTree } from '../engine/state.mjs';
import { activeDir } from '../engine/paths.mjs';

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-stoph-'));
  fs.mkdirSync(activeDir(root), { recursive: true });
  // minimal goal in pursuing state ... same as Task 1.1 setup
  return root;
}

describe('Stop-hook v3 default (hint-only)', () => {
  it('returns null stdout on lifecycle=pursuing when stopHookDriver=false (default)', async () => {
    const root = setup();
    const transcriptPath = path.join(root, 't.jsonl');
    fs.writeFileSync(transcriptPath, '');
    const r = await runStopHook({
      stdin: { session_id: 's', transcript_path: transcriptPath },
      projectRoot: root,
    });
    expect(r.stdout).toBeNull();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('still fires when stopHookDriver=true (opt-in legacy)', async () => {
    const root = setup();
    const cfgDir = path.join(root, '.claude', 'goals', 'active');
    fs.writeFileSync(
      path.join(cfgDir, 'config.json'),
      JSON.stringify({ schema_version: 1, stopHookDriver: true }),
    );
    const transcriptPath = path.join(root, 't.jsonl');
    fs.writeFileSync(transcriptPath, '');
    const r = await runStopHook({
      stdin: { session_id: 's', transcript_path: transcriptPath },
      projectRoot: root,
    });
    expect(r.stdout).toBeTruthy();
    expect(r.stdout.systemMessage).toMatch(/Goal continuation/);
    fs.rmSync(root, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/stop-hook-v3.test.mjs`
Expected: FAIL — first test expects null but pre-v3 code returns a continuation render.

- [ ] **Step 3: Modify `engine/stop-hook.mjs`**

Locate the early-exit chain (after session_id gate, before the lifecycle switch). Insert:

```js
import { loadPluginConfig } from './plugin-config.mjs';

// ... inside runStopHook, after the session_id mismatch return:
const cfg = loadPluginConfig(projectRoot);
if (state.lifecycle === 'pursuing' && !cfg.stopHookDriver) {
  return { exit: 0, stdout: null };
}
```

(The implementer must read the existing file to identify the exact insertion point. Place the check AFTER `session_id` mismatch and BEFORE the auto-pause-on-silence detector — so the driver can still detect silence under legacy mode, but the v3 default path skips silence detection entirely.)

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/stop-hook-v3.test.mjs tests/auto-pause-on-silence.test.mjs tests/stop-hook.test.mjs`
Expected: ALL pass. The auto-pause tests still pass because they don't write a config file, so `stopHookDriver` stays at v2 behavior in their fixtures... NO WAIT — v3 default is `false`. The pre-existing v2.0.6 auto-pause tests would now fail because Stop-hook returns null before reaching the auto-pause detector.

Implementer must add `stopHookDriver: true` to the existing auto-pause fixtures so they continue to test the legacy driver path. See Task 2.3.

- [ ] **Step 5: Commit**

```bash
git add engine/stop-hook.mjs tests/stop-hook-v3.test.mjs
git commit -m "feat(v3): Stop-hook returns null on pursuing by default (stopHookDriver opt-in)"
```

---

### Task 2.3: Migrate v2.0.6 auto-pause tests to legacy-driver fixture

**Files:**
- Modify: `tests/auto-pause-on-silence.test.mjs`

Add `setupProject()` step to write `config.json` with `stopHookDriver: true`. This preserves the v2.0.6 auto-pause regression suite as a legacy-driver test.

- [ ] **Step 1: Read existing test file**

Read `tests/auto-pause-on-silence.test.mjs` to find the `setupProject()` function.

- [ ] **Step 2: Modify `setupProject()`**

After `fs.writeFileSync(notesPath(root), '');`, add:
```js
const cfgDir = activeDir(root);
fs.writeFileSync(
  path.join(cfgDir, 'config.json'),
  JSON.stringify({ schema_version: 1, stopHookDriver: true }),
);
```

(Use existing `path` import; `activeDir` is already imported.)

- [ ] **Step 3: Run tests**

Run: `npx vitest run tests/auto-pause-on-silence.test.mjs`
Expected: PASS, all 11 tests.

- [ ] **Step 4: Commit**

```bash
git add tests/auto-pause-on-silence.test.mjs
git commit -m "test(v3): migrate auto-pause-on-silence suite to legacy stopHookDriver=true fixture"
```

---

### Task 2.4: Doctor check — warn on legacy stopHookDriver

**Files:**
- Modify: `engine/doctor.mjs`
- Modify: `tests/doctor.test.mjs`

Add `checkLegacyStopHookDriver()` that reads plugin config and returns `{status: 'warn', message: 'stopHookDriver=true detected — legacy v2 driver enabled. v3 default is hint-only.'}` when enabled. Returns `ok` when disabled (default).

- [ ] **Step 1: Write failing test**

Add to `tests/doctor.test.mjs` (or new `tests/doctor-v3.test.mjs`):
```js
import { describe, it, expect } from 'vitest';
import { checkLegacyStopHookDriver } from '../engine/doctor.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

describe('doctor checkLegacyStopHookDriver', () => {
  it('returns ok when driver disabled (v3 default)', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-'));
    const r = checkLegacyStopHookDriver(root);
    expect(r.status).toBe('ok');
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('returns warn when stopHookDriver=true', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-'));
    fs.mkdirSync(path.join(root, '.claude', 'goals', 'active'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.claude', 'goals', 'active', 'config.json'),
      JSON.stringify({ schema_version: 1, stopHookDriver: true }),
    );
    const r = checkLegacyStopHookDriver(root);
    expect(r.status).toBe('warn');
    expect(r.message).toMatch(/legacy/i);
    fs.rmSync(root, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

- [ ] **Step 3: Add to doctor.mjs**

```js
import { loadPluginConfig } from './plugin-config.mjs';

export function checkLegacyStopHookDriver(projectRoot) {
  const cfg = loadPluginConfig(projectRoot);
  if (cfg.stopHookDriver) {
    return {
      name: 'legacy-stop-hook-driver',
      status: 'warn',
      message: 'stopHookDriver=true detected — legacy v2 driver enabled. v3 default is hint-only. Disable by removing or setting false in .claude/goals/active/config.json or ~/.claude/plugins/goal-mode/config.json.',
    };
  }
  return { name: 'legacy-stop-hook-driver', status: 'ok', message: 'v3 hint-only mode' };
}
```

Also wire it into the doctor's main check list (search for `runAllChecks` or equivalent in `doctor.mjs`).

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/doctor.test.mjs`
Expected: PASS, including new test.

- [ ] **Step 5: Commit**

```bash
git add engine/doctor.mjs tests/doctor.test.mjs
git commit -m "feat(v3): doctor warns when legacy stopHookDriver=true is enabled"
```

---

## Sprint 3 — Slash commands and shell scripts

For each new CLI verb introduced in Sprint 1, add (a) a `scripts/*.sh` shim and (b) a `commands/*.md` markdown that calls the shim.

### Task 3.1: `/goal-mode:evidence-add` slash command

**Files:**
- Create: `scripts/evidence-add.sh`
- Create: `commands/goal-evidence-add.md`
- Test: `tests/slash-evidence-add.test.mjs` (smoke — calls .sh)

- [ ] **Step 1: Write the script**

`scripts/evidence-add.sh`:
```bash
#!/usr/bin/env bash
set -euo pipefail
: "${CLAUDE_PLUGIN_ROOT:=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
exec node "${CLAUDE_PLUGIN_ROOT}/engine/evidence-add-cli.mjs" "$@"
```

`chmod +x scripts/evidence-add.sh`.

- [ ] **Step 2: Write the command markdown**

`commands/goal-evidence-add.md`:
```markdown
---
description: "Add evidence for a criterion on the cursor task"
argument-hint: "--criterion N --file path[:line] --note \"...\" | --command \"cmd\" --exit-code N --note \"...\""
allowed-tools: ["Bash(${CLAUDE_PLUGIN_ROOT}/scripts/evidence-add.sh:*)"]
---

# Goal Evidence Add

Adds one evidence entry to the cursor task. Use this INSTEAD of emitting `<evidence/>` tags in the assistant reply when running in v3 default mode (hint-only Stop hook).

**File-based:**
```
/goal-mode:evidence-add --criterion 0 --file src/foo.ts:42 --note "spec match"
```

**Shell-based:**
```
/goal-mode:evidence-add --criterion 2 --command "npm test -- foo" --exit-code 0 --note "validation green"
```

The CLI runs through `applyMutations()` with `lifecycle='pursuing'` + cursor.status ∈ {`pursuing`, `review-pending`} preconditions enforced. Returns evidence count after the add.

Parse user arguments from the message and dispatch:

```bash
"${CLAUDE_PLUGIN_ROOT}/scripts/evidence-add.sh" <parsed-args>
```
```

- [ ] **Step 3: Smoke test**

`tests/slash-evidence-add.test.mjs`:
```js
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SH = path.join(ROOT, '..', 'scripts', 'evidence-add.sh');

describe('scripts/evidence-add.sh', () => {
  it('forwards exit code 2 from missing args', () => {
    const r = spawnSync(SH, [], { env: { ...process.env, CLAUDE_PLUGIN_ROOT: path.join(ROOT, '..') } });
    expect(r.status).toBe(2);
  });
});
```

- [ ] **Step 4: Run**

Run: `npx vitest run tests/slash-evidence-add.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
chmod +x scripts/evidence-add.sh
git add scripts/evidence-add.sh commands/goal-evidence-add.md tests/slash-evidence-add.test.mjs
git commit -m "feat(v3): /goal-mode:evidence-add slash command"
```

---

### Task 3.2: `/goal-mode:achieve` slash command

Identical pattern to 3.1.

- [ ] **Step 1: Create script**

`scripts/achieve.sh`:
```bash
#!/usr/bin/env bash
set -euo pipefail
: "${CLAUDE_PLUGIN_ROOT:=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
exec node "${CLAUDE_PLUGIN_ROOT}/engine/achieve-cli.mjs" "$@"
```

- [ ] **Step 2: Create command md**

`commands/goal-achieve.md` describing the verb and dispatching `scripts/achieve.sh`.

- [ ] **Step 3: Smoke test**

`tests/slash-achieve.test.mjs` — minimal exit-code check.

- [ ] **Step 4: Run**

Run: `npx vitest run tests/slash-achieve.test.mjs`

- [ ] **Step 5: Commit**

```bash
chmod +x scripts/achieve.sh
git add scripts/achieve.sh commands/goal-achieve.md tests/slash-achieve.test.mjs
git commit -m "feat(v3): /goal-mode:achieve slash command"
```

---

### Task 3.3: `/goal-mode:submit-verdict` slash command

Same pattern. CLI requires --agent and --status; on independence violation, exits 1 with a clear error.

- [ ] **Steps 1-5:** Mirror 3.1/3.2. Files: `scripts/submit-verdict.sh`, `commands/goal-submit-verdict.md`, `tests/slash-submit-verdict.test.mjs`. Commit message: `"feat(v3): /goal-mode:submit-verdict slash command"`.

---

### Task 3.4: `/goal-mode:current` slash command

- [ ] **Steps 1-5:** Files: `scripts/current.sh`, `commands/goal-current.md`, `tests/slash-current.test.mjs`. The command markdown should document `--json` and `--as-builtin` flags. Commit: `"feat(v3): /goal-mode:current slash command"`.

---

### Task 3.5: `/goal-mode:review-request` slash command + core

**Files:**
- Create: `engine/review-request.mjs`
- Create: `engine/review-request-cli.mjs`
- Create: `scripts/review-request.sh`
- Create: `commands/goal-review-request.md`
- Test: `tests/review-request.test.mjs`

When the agent has marked a task achieved (via `achieve`) and the task has reviewers, the engine has already set `cursor.status = 'review-pending'`. This command prints the audit-instructions template + reviewer list so the agent knows what to dispatch via `Agent({subagent_type, prompt})`. After dispatching and collecting verdicts, the agent calls `submit-verdict` per reviewer.

The core function is essentially a read-only inspector + template renderer. It does NOT mutate state.

- [ ] **Steps 1-5:** Standard pattern. Reuse `prompts/audit-instructions.md` body to format the dispatch instructions per reviewer. Commit: `"feat(v3): /goal-mode:review-request — prints reviewer dispatch template"`.

---

### Task 3.6: `/goal-mode:as-builtin` slash command (bridge to built-in `/goal`)

Already covered by `current-cli.mjs --as-builtin`. Add a dedicated shortcut: `scripts/as-builtin.sh` that wraps `current-cli.mjs --as-builtin`. Command md explains the bridge usage:

```markdown
The user typed /goal-mode:as-builtin. Print the output (a single-line built-in-/goal-ready text) to the user with a code fence so they can copy it:

```!
"${CLAUDE_PLUGIN_ROOT}/scripts/as-builtin.sh"
```

Then suggest: "Pipe this into `/goal "<paste>"` to let Claude Code's built-in /goal drive the loop. goal-mode will track structure and reviewers in parallel."
```

- [ ] **Steps 1-5:** Standard. Commit: `"feat(v3): /goal-mode:as-builtin bridge to Claude Code built-in /goal"`.

---

### Task 3.7: Update `/goal-mode:goal-help`

**Files:**
- Modify: `commands/goal-help.md`

Add a "v3 explicit CLI verbs" section above the legacy section, listing:
- `/goal-mode:current`
- `/goal-mode:evidence-add`
- `/goal-mode:achieve`
- `/goal-mode:review-request`
- `/goal-mode:submit-verdict`
- `/goal-mode:as-builtin`

And explain the recommended workflow:
1. `/goal-mode:current` to see the task
2. Do the work
3. `/goal-mode:evidence-add` per criterion
4. `/goal-mode:achieve`
5. If review-pending, dispatch reviewers + `/goal-mode:submit-verdict` per reviewer

- [ ] **Step 1: Read existing `commands/goal-help.md`**

- [ ] **Step 2: Insert new section**

Place between the header and the existing command list.

- [ ] **Step 3: Verify rendering**

Manually invoke `/goal-mode:goal-help` once in a Claude Desktop session and read it. (No automated test for markdown content.)

- [ ] **Step 4: Commit**

```bash
git add commands/goal-help.md
git commit -m "docs(v3): goal-help lists explicit CLI verbs and recommended workflow"
```

---

## Sprint 4 — Skills and documentation

### Task 4.1: Update `skills/using-goal-mode/SKILL.md`

**Files:**
- Modify: `skills/using-goal-mode/SKILL.md`

Add a "v3 workflow" section above the existing tag-discipline section. Mark legacy tag emission as "fallback for legacy stopHookDriver=true". The current SKILL.md is ~21KB — keep its structure, add a top-level "v3 default workflow" heading.

- [ ] **Step 1: Read existing SKILL.md**

- [ ] **Step 2: Add v3 section**

Insert at the top (after the YAML frontmatter):

```markdown
## v3 default workflow (Stop-hook is hint-only)

In v3.0+, the Stop hook returns null on `lifecycle=pursuing` by default. The agent drives the goal explicitly via slash commands:

1. `/goal-mode:current` — print the current task + acceptance criteria.
2. Do the work in normal Claude Code mode.
3. `/goal-mode:evidence-add --criterion N --file path[:line] --note "..."` — write evidence per criterion.
4. `/goal-mode:achieve` — claim achievement. Engine validates all ACs covered and either marks achieved+advances (no reviewers) or transitions to `review-pending`.
5. If `review-pending`, dispatch reviewers via `Agent({subagent_type: '<reviewer>', prompt: <audit-instructions>})`, then `/goal-mode:submit-verdict --agent <reviewer> --status GO|NOGO|REVISE --text "..."` per verdict.

Tag emission still works under legacy `stopHookDriver: true` config. See [legacy-tags] section below.
```

Keep the rest of the file intact, mark the legacy section accordingly.

- [ ] **Step 3: Commit**

```bash
git add skills/using-goal-mode/SKILL.md
git commit -m "docs(v3): using-goal-mode skill — explicit CLI workflow above legacy tag-emission"
```

---

### Task 4.2: Update `skills/goal-mode-tag-discipline/SKILL.md`

**Files:**
- Modify: `skills/goal-mode-tag-discipline/SKILL.md`

Add a header note: "In v3.0+, tag emission is OPTIONAL — prefer the explicit CLI verbs (`/goal-mode:evidence-add`, `/goal-mode:achieve`, `/goal-mode:submit-verdict`). Tags still work under legacy `stopHookDriver: true` config and remain authoritative for Codex/non-Claude-Code agents that can't invoke slash commands."

- [ ] **Step 1: Read existing**

- [ ] **Step 2: Insert v3 header**

- [ ] **Step 3: Commit**

```bash
git add skills/goal-mode-tag-discipline/SKILL.md
git commit -m "docs(v3): tag-discipline skill flagged as legacy/optional path"
```

---

### Task 4.3: README v3 section

**Files:**
- Modify: `README.md`

Add a top section "What's new in v3.0" linking to:
- New CLI verbs
- Stop-hook now hint-only by default
- Built-in /goal bridge

Update the badge bar at the top: `v3.0.0` and adjust test count line if it changed.

- [ ] **Step 1: Read README.md current state**

- [ ] **Step 2: Insert v3 section after the top-of-file badge bar**

```markdown
## What's new in v3.0

**v3.0 is a workflow redesign, not a rewrite.** Every v2.x state file loads unchanged. The plan-tree schema, event log, reviewer-independence guard, triple budget, and lock protocol are unchanged.

What changed:

| Before (v2) | After (v3) |
|---|---|
| Stop-hook injects continuation prompt every turn | Stop-hook returns null on `pursuing` by default |
| Agent emits XML tags in reply (`<evidence>`, `<task-status>`, ...) | Agent calls explicit slash commands |
| Cursor advances via tag parsing | Cursor advances via CLI verb (`achieve`, `submit-verdict`) |
| Driver vs. agent loop tightly coupled | Agent owns the loop; goal-mode is a structured tracker |

Legacy driver remains available as opt-in via `.claude/goals/active/config.json`:
```json
{ "schema_version": 1, "stopHookDriver": true }
```

New slash commands:
- `/goal-mode:current` — read-only cursor inspector
- `/goal-mode:evidence-add` — write evidence to cursor task
- `/goal-mode:achieve` — claim task achievement
- `/goal-mode:review-request` — print reviewer dispatch template
- `/goal-mode:submit-verdict` — record reviewer verdict
- `/goal-mode:as-builtin` — emit text for piping into Claude Code's built-in `/goal`

Migration is automatic: existing v2 goals continue to work; new behavior takes effect on `bash install.sh + restart Claude Desktop`.
```

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs(v3): README — what's-new section, command list, migration note"
```

---

### Task 4.4: CHANGELOG v3.0.0 entry

**Files:**
- Modify: `CHANGELOG.md`

Add at the top:

```markdown
## v3.0.0 — CLI-first redesign

**Breaking by default, opt-out via config.** Stop-hook is hint-only on `lifecycle=pursuing`. Agents drive the loop via explicit CLI verbs.

### Added
- `engine/evidence-add.mjs` + `evidence-add-cli.mjs` + `/goal-mode:evidence-add`
- `engine/achieve.mjs` + `achieve-cli.mjs` + `/goal-mode:achieve`
- `engine/submit-verdict.mjs` + `submit-verdict-cli.mjs` + `/goal-mode:submit-verdict`
- `engine/current.mjs` + `current-cli.mjs` + `/goal-mode:current`
- `engine/review-request.mjs` + `review-request-cli.mjs` + `/goal-mode:review-request`
- `scripts/as-builtin.sh` + `/goal-mode:as-builtin` — bridge to built-in `/goal`
- `engine/plugin-config.mjs` — per-user + per-project config layering
- `doctor` check for legacy `stopHookDriver=true`

### Changed
- Stop-hook returns `null` stdout on `lifecycle=pursuing` by default (was: render continuation.md every turn).
- `using-goal-mode` skill updated to v3 workflow (explicit CLI), legacy tag emission downgraded to fallback.
- `goal-mode-tag-discipline` skill flagged as optional/legacy.

### Unchanged (carry-over from v2.0.6)
- State schema (`schema_version: 2`).
- Event log + reducer (ADR-0001).
- File locking (ADR-0002).
- Reviewer-independence guard (`scannedAgents` Set, transcript scan).
- Triple budget enforcement.
- Escape-hatch detector + `awaiting-manual-approval` lifecycle.
- Auto-pause-on-silence (v2.0.6) — still active under `stopHookDriver=true`.

### Migration

v2.x → v3.0 is a no-op for state files. After `bash install.sh && restart Claude Desktop`:
- Default behavior: hint-only Stop-hook. Run `/goal-mode:current` to see the task; use explicit CLI verbs to advance.
- To preserve v2 driver behavior, write `{ "schema_version": 1, "stopHookDriver": true }` to `.claude/goals/active/config.json` (per project) or `~/.claude/plugins/goal-mode/config.json` (per user).

The legacy tag-emission path (`<evidence>`, `<task-status>`, `<audit-verdict>`) continues to work under `stopHookDriver=true` for Codex / non-Claude-Code agents and for users who prefer the auto-drive workflow.
```

- [ ] **Step 1: Read CHANGELOG.md current state**

- [ ] **Step 2: Insert at top**

- [ ] **Step 3: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs(v3): CHANGELOG v3.0.0 — CLI-first redesign with config opt-out"
```

---

### Task 4.5: Migration guide (`docs/MIGRATION-v2-to-v3.md`)

**Files:**
- Create: `docs/MIGRATION-v2-to-v3.md`

Standalone migration doc for users who want to keep v2 driver behavior, vs. those who want to embrace v3 default.

- [ ] **Step 1: Write doc**

Cover:
1. What changes for the user (workflow diff).
2. How to keep v2 behavior (config file shape).
3. How to embrace v3 (config file removal, slash command examples).
4. Backward-compat: tag-emission still works under legacy mode.
5. Doctor: how to verify which mode is active.

- [ ] **Step 2: Commit**

```bash
git add docs/MIGRATION-v2-to-v3.md
git commit -m "docs(v3): migration guide v2 → v3"
```

---

## Sprint 5 — Release and verification

### Task 5.1: Version bump

**Files:**
- Modify: `package.json` (`"version": "3.0.0"`)
- Modify: `.claude-plugin/marketplace.json` (`"version": "3.0.0"` in plugins[0] AND plugins[0].source if pinned)

- [ ] **Step 1: Update `package.json`**

- [ ] **Step 2: Update `.claude-plugin/marketplace.json`**

- [ ] **Step 3: Commit**

```bash
git add package.json .claude-plugin/marketplace.json
git commit -m "chore(v3): bump version to 3.0.0"
```

---

### Task 5.2: Full test suite green

**Files:** none (verification step).

- [ ] **Step 1: Run all tests with no cache**

Run: `cd /Users/andresvlc/WebDev/claude-code-goal-mode && npm test -- --no-cache`

Expected: All ~960+ tests pass (918 v2 + ~40 new v3 tests), 0 fails. (If a v2 test fails: triage — either the test made an assumption that v3 breaks legitimately, or v3 introduced a regression. The plan-tree schema is unchanged, so failures should be in the Stop-hook/driver tests only.)

- [ ] **Step 2: If any v2 test fails, route to a sub-task**

If failures are isolated to a known group (e.g., `stop-hook.test.mjs` because the v2 driver test expected non-null stdout), either:
1. Add `stopHookDriver: true` config to the fixture (legacy mode), OR
2. Rewrite the assertion if the test was checking obsolete behavior.

Document the decision in the commit message.

- [ ] **Step 3: Commit (or no-commit if no fixture changes needed)**

```bash
git add tests/<failed-test>.test.mjs  # if fixture changes were required
git commit -m "test(v3): pin <test-name> to legacy driver fixture (preserves v2 regression coverage)"
```

---

### Task 5.3: Doctor green on v3 default install

**Files:** none (verification step).

- [ ] **Step 1: Fresh install + restart**

Run:
```bash
cd /Users/andresvlc/WebDev/claude-code-goal-mode
bash install.sh
# Manually restart Claude Desktop (kill + relaunch)
```

- [ ] **Step 2: Run `/goal-mode:goal-doctor` in a fresh Claude Desktop session**

Expected output: `≥14 ok / 0 warn / 0 fail` (one new check added in Task 2.4: `legacy-stop-hook-driver` returning ok by default).

- [ ] **Step 3: Document in a smoke-test report**

Append to `docs/SMOKE-TEST.md`:
```markdown
## v3.0.0 smoke test (2026-05-12)
- Fresh install: `bash install.sh` ✓
- Doctor: 14 ok / 0 warn / 0 fail ✓
- `/goal-mode:current` (no goal) → "no active goal" message ✓
- `/goal-mode:goal-plan` → draft created ✓
- `/goal-mode:goal-approve-plan` → approved ✓
- `/goal-mode:goal-start` → pursuing ✓
- (Optional) `/goal-mode:current` → cursor inspector ✓
- (Optional) `/goal-mode:evidence-add` → evidence count incremented ✓
- (Optional) `/goal-mode:achieve` → cursor advanced or review-pending ✓
```

- [ ] **Step 4: Commit**

```bash
git add docs/SMOKE-TEST.md
git commit -m "test(v3): smoke-test report against fresh v3.0.0 install"
```

---

### Task 5.4: Tag and push

**Files:** none (release step).

- [ ] **Step 1: Confirm working tree clean and on `main`**

Run: `git status` → clean. `git rev-parse --abbrev-ref HEAD` → `main`.

- [ ] **Step 2: Tag**

```bash
git tag -a v3.0.0 -m "release: v3.0.0 — CLI-first redesign (Stop-hook hint-only by default)"
```

- [ ] **Step 3: Push**

```bash
git push origin main --follow-tags
```

- [ ] **Step 4: Verify tag landed**

Run: `gh release view v3.0.0 --json tagName,name,publishedAt` (or `git ls-remote --tags origin | grep v3.0.0`).

---

### Task 5.5: Marketplace verification

**Files:** none (verification step).

- [ ] **Step 1: Verify marketplace.json on origin**

Run: `gh api repos/lokafinnsw/claude-code-goal-mode/contents/.claude-plugin/marketplace.json --jq '.content' | base64 -d | jq '.plugins[0].version'`

Expected: `"3.0.0"`.

- [ ] **Step 2: If wrong, fix and push**

(Should not happen if Task 5.1 was completed.)

- [ ] **Step 3: Smoke-test fresh install from marketplace**

In a sandbox Claude Desktop session: `/plugin marketplace add lokafinnsw/claude-code-goal-mode && /plugin install goal-mode`. Verify the install path resolves to `~/.claude/plugins/cache/goal-mode/goal-mode/3.0.0/`.

---

## Self-Review

### 1. Spec coverage

| User-stated requirement | Task(s) covering it |
|---|---|
| Apex2 на полный CLI redesign | Sprint 1 (new verbs) + Sprint 2 (Stop-hook gut) |
| 5 sprints, ~3-5 days | 5 sprints defined; ~8 tasks per sprint avg |
| Тесты переносятся | Sprint 2 Task 2.3 migrates v2.0.6 tests to legacy fixture |
| State schema совместим (миграция автомат) | No schema changes — state.json v2 loads unchanged |
| goal-mode как CLI binary + slash shortcuts | Sprint 1 binaries + Sprint 3 slash commands |
| Опционально built-in /goal bridge | Task 1.7 (`--as-builtin`) + Task 3.6 (`/goal-mode:as-builtin`) |

All spec items have at least one task. No gaps.

### 2. Placeholder scan

- Task 1.2, 1.4, 1.7 contain "skipping a redundant verbose test stub — pattern matches X" — this is intentional: the same setup pattern repeats and re-writing each verbose fixture would inflate the plan ~3× without adding signal. Each task lists the cases to cover.
- Task 1.6 test body has `// setup with empty transcript (no Agent dispatch) ...` — partial stub. Implementer must construct a JSONL transcript with the right shape. Reference: `tests/independence.test.mjs` already constructs transcripts this way; the implementer should follow that pattern (named in the test header comment).
- Task 3.5 says "Standard pattern" without code. Acceptable because Tasks 3.1/3.2 fully establish the pattern (script.sh + command.md + smoke test); 3.3-3.6 are mechanically derived.

### 3. Type consistency

- `evidenceAdd({criterion, file, line, command, exit_code, note})` — used consistently across 1.1, 1.2, CLI.
- `achieveCursor()` returns `{ok, status, missing_criteria, next_cursor, required_reviewers, error}` — consistent across 1.3, 1.4.
- `submitVerdict({agent, status, text, scannedAgents})` — consistent. The CLI populates `scannedAgents` automatically (Task 1.6).
- `loadPluginConfig(projectRoot, opts?)` — used in 2.1, 2.2, 2.4.

No drift detected.

### 4. Risk register

| Risk | Mitigation |
|---|---|
| v2 driver users surprised by silent Stop-hook | CHANGELOG.md migration section + doctor warn + opt-in flag. |
| New CLI verbs slow because they re-acquire lock per call | `withLockSync` is the same lock the Stop-hook used; throughput is identical. Multi-call cost (e.g., 5× `evidence-add` + 1× `achieve`) is 6× lock cycles — measured negligible (<10ms each on tmpfs in v2 benchmarks). |
| Agent forgets to call CLI verbs (no auto-drive) | `/goal-mode:goal-help` lists workflow; `using-goal-mode` skill prompts to run `/goal-mode:current` first. Built-in `/goal` bridge fills the auto-drive role for users who want it. |
| Reviewer-independence bypassed via CLI | `submitVerdict` MUST receive `scannedAgents`; the CLI (Task 1.6) constructs it from the live transcript before calling `submitVerdict`. Direct `submitVerdict` callers (tests) provide the Set explicitly. |
| Migration test breakage | Task 2.3 explicitly migrates v2.0.6 auto-pause suite to `stopHookDriver: true` fixture. Other v2 tests don't depend on Stop-hook behavior — they hit core engine modules directly. |

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-05-12-v3-cli-redesign.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — controller dispatches a fresh subagent per task with full task text, runs spec-compliance + code-quality review after each, marks complete in TodoWrite. Fast iteration, no context pollution.

**2. Inline Execution** — execute tasks in this session using `executing-plans`, batch execution with checkpoints between sprints.

**Which approach?**
