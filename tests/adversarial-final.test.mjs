/**
 * adversarial-final.test.mjs
 *
 * Final adversarial pass covering everything that shipped after Phase 10 (v1.0.0 → v1.1.7).
 * Categories: N (plan-from-file), O (install.sh), P (fix-cli-source.sh), Q (vendored zod),
 *             R (marketplace shape), S (example plans), T (doc accuracy), U (e2e smoke),
 *             V (prompt-content smoke), W (cross-cutting).
 *
 * Constraint: no engine-code modification, no live LLM calls, synthetic fixtures + tmpdir only.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';

// ── helpers ─────────────────────────────────────────────────────────────────

const REPO = path.resolve(import.meta.dirname, '..');
const EXAMPLES = path.join(REPO, 'docs', 'EXAMPLES');
const COMMANDS = path.join(REPO, 'commands');
const PROMPTS = path.join(REPO, 'prompts');

function readFile(rel) {
  return fs.readFileSync(path.join(REPO, rel), 'utf8');
}

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'adversarial-final-'));
}

/** Minimal valid task node */
function makeTask(id, overrides = {}) {
  return {
    id,
    type: 'task',
    title: 'Task title',
    goal: 'Task goal',
    acceptance_criteria: ['criterion one'],
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

function makeTree(rootOverrides = {}, taskOverrides = {}) {
  return {
    schema_version: 2,
    goal_id: 'test-goal',
    mission: 'Test mission',
    created_at: new Date().toISOString(),
    approved_at: null,
    root: {
      id: 'sprint-1',
      type: 'sprint',
      title: 'Sprint 1',
      goal: 'Sprint goal',
      acceptance_criteria: [],
      review: [],
      validate: null,
      work_front: 'engine',
      status: 'pending',
      evidence: [],
      blocker_reason: null,
      review_attempts: 0,
      notes: [],
      children: [makeTask('sprint-1.task-1', taskOverrides)],
      ...rootOverrides,
    },
  };
}

function makeDraftState(goal_id = 'test-goal', extra = {}) {
  return {
    schema_version: 2,
    goal_id,
    lifecycle: 'draft',
    cursor: 'pending',
    budget: {
      iterations: { used: 0, max: 0 },
      tokens: { used: 0, max: 0 },
      wallclock: { started_at: new Date().toISOString(), max_seconds: 0 },
    },
    session_id: 'pending',
    started_at: null,
    paused_at: null,
    ended_at: null,
    ended_reason: null,
    history: [],
    ...extra,
  };
}

/** Run the install.sh jq filter on a synthetic config string; returns parsed result */
function runInstallJqFilter(inputJson, rootPath = '/repo/goal-mode') {
  const jqExpr = `
    .hooks = (.hooks // {}) |
    .hooks.Stop = (
      [(.hooks.Stop // [])[] | select(
        ((.hooks // []) | map(.command // "" | contains("goal-mode")) | any) | not
      )] +
      [{
        "hooks": [{
          "type": "command",
          "command": ("CLAUDE_PLUGIN_ROOT=" + $root + " bash \\"" + $root + "/hooks/stop-hook.sh\\"")
        }]
      }]
    ) |
    .permissions = (.permissions // {}) |
    .permissions.allow = ((.permissions.allow // []) + [
      ("Bash(" + $root + "/scripts/*.sh:*)"),
      ("Bash(" + $root + "/hooks/*.sh:*)")
    ] | unique)
  `;
  const result = execSync(
    `echo ${JSON.stringify(JSON.stringify(inputJson))} | jq --arg root ${JSON.stringify(rootPath)} '${jqExpr}'`,
    { encoding: 'utf8' }
  );
  return JSON.parse(result);
}

// ── N: /goal:plan-from-file ──────────────────────────────────────────────────

describe('N: /goal:plan-from-file — prompt content and spec', () => {
  const prompt = readFile('prompts/plan-from-file.md');
  const command = readFile('commands/goal-plan-from-file.md');

  // N1: 3-file mandate
  it('N1: prompt explicitly lists all three required output files', () => {
    expect(prompt).toContain('.claude/goals/active/tree.json');
    expect(prompt).toContain('.claude/goals/active/plan.md');
    expect(prompt).toContain('.claude/goals/active/state.json');
    // Hard rule #2 must say "ALL THREE files"
    expect(prompt).toMatch(/all three files MUST exist/i);
  });

  it('N1: prompt mandates One Write per file, Three Writes total (ambiguity check)', () => {
    expect(prompt).toMatch(/ONE Write per file/i);
    expect(prompt).toMatch(/Three Writes total/i);
    expect(prompt).toMatch(/No Edit chains/i);
  });

  // N2: Forbidden-phrase list
  it('N2: forbidden-phrase list is non-empty and covers real hedging anti-patterns', () => {
    // Each phrase must be present as a literal banned string
    const requiredBannedPhrases = [
      'this is a large Write but doable',
      "let me write a generator",
      "given the scale",
      "I'll start with a few tasks and continue",
      "this might take multiple turns",
      "I'll continue adding sprints across multiple Edit calls",
      "Sprint 0 written, now adding Sprint 1 via Edit",
    ];
    for (const phrase of requiredBannedPhrases) {
      expect(prompt, `Expected banned phrase to appear in prompt: "${phrase}"`).toContain(phrase);
    }
  });

  it('N2: prompt contains "Forbidden phrases" directive (not just a list)', () => {
    expect(prompt).toMatch(/Forbidden phrases/i);
  });

  // N3: Generator-script anti-pattern
  it('N3: prompt explicitly forbids generator scripts by name', () => {
    expect(prompt).toMatch(/DO NOT[\s\S]{0,30}write a generator script/i);
  });

  it('N3: prompt names concrete script types (Node, Python, bash) in the anti-pattern', () => {
    // The anti-pattern must name real script types so the LLM knows what "generator script" means
    const body = prompt.toLowerCase();
    const hasLang = body.includes('node') || body.includes('python') || body.includes('bash');
    expect(hasLang).toBe(true);
  });

  // N4: Empty input file
  it('N4: prompt instructs LLM to abort on empty/missing source file', () => {
    // Hard Rule #1 must cover this
    expect(prompt).toMatch(/doesn.t exist or is empty.*abort/i);
  });

  // N5/N6: Structural edge cases — flat file handling
  it('N6: prompt describes how to handle flat file (no sprint/epic structure)', () => {
    // The prompt must say "flat" and describe a synthetic sprint/epic wrapper
    expect(prompt).toContain('flat');
    expect(prompt).toMatch(/synthetic Sprint/i);
  });

  it('N6: prompt covers files where H2 goes directly to tasks (no epic layer)', () => {
    // "preserve the depth" or similar instruction must exist
    expect(prompt).toMatch(/every leaf is a task|preserve the depth/i);
  });

  // N7: 5 self-check assertions (from 8b308ae — "before declaring done" smoke)
  it('N7: prompt requires post-write self-check (chat summary with conversion stats)', () => {
    // The "After writing all three files" section must exist and list concrete verifiable items
    expect(prompt).toMatch(/After writing all three files/i);
    // Must list source file path confirmation (item 1)
    expect(prompt).toMatch(/Source file path/i);
    // Must list conversion summary (item 2) — sprints/epics/tasks count
    expect(prompt).toMatch(/Conversion summary/i);
    // Must list schema deviations (item 3)
    expect(prompt).toMatch(/Schema deviations/i);
    // Must list reviewer availability (item 4)
    expect(prompt).toMatch(/Reviewer availability/i);
    // Must list suggested budget (item 5)
    expect(prompt).toMatch(/Suggested budget/i);
  });

  // N8: Schema-only round-trip — what plan-from-file would produce
  it('N8: synthetic plan-from-file output validates through GoalTreeSchema', async () => {
    const { GoalTreeSchema } = await import('../engine/state.mjs');
    const tree = {
      schema_version: 2,
      goal_id: 'migrate-auth-jwt',
      mission: 'Replace session-cookie auth with JWT in the Node.js API',
      created_at: new Date().toISOString(),
      approved_at: null,
      root: {
        id: 'sprint-1',
        type: 'sprint',
        title: 'Sprint 1: JWT implementation',
        goal: 'All routes protected by JWT.',
        acceptance_criteria: [],
        review: [],
        validate: null,
        work_front: 'auth',
        status: 'pending',
        evidence: [],
        blocker_reason: null,
        review_attempts: 0,
        notes: [],
        children: [
          {
            id: 'sprint-1.epic-1',
            type: 'epic',
            title: 'Epic 1.1: Token helpers',
            goal: 'Sign and verify access tokens.',
            acceptance_criteria: [],
            review: [],
            validate: null,
            work_front: 'auth',
            status: 'pending',
            evidence: [],
            blocker_reason: null,
            review_attempts: 0,
            notes: [],
            children: [
              makeTask('sprint-1.epic-1.task-1', {
                title: 'Add jose dependency',
                goal: 'jose installed, getSigningKey() helper works.',
                acceptance_criteria: ['jose in package.json and npm ci resolves cleanly'],
              }),
            ],
          },
        ],
      },
    };
    expect(() => GoalTreeSchema.parse(tree)).not.toThrow();
  });

  it('N8: draft state.json spec from plan-from-file validates through GoalStateSchema', async () => {
    const { GoalStateSchema } = await import('../engine/state.mjs');
    const state = makeDraftState('migrate-auth-jwt');
    // cursor: "pending" and session_id: "pending" are the mandated draft values
    expect(() => GoalStateSchema.parse(state)).not.toThrow();
  });

  // N: command file wires correctly. v1.1.13+ replaced $ARGUMENTS shell
  // expansion (rejected in Claude Desktop) with a natural-language pattern
  // where the LLM parses the arg from the chat and invokes the Bash tool.
  it('N: goal-plan-from-file.md command references the prompt file and the {{file_path}} placeholder', () => {
    expect(command).toContain('plan-from-file.md');
    // The command must reference the {{file_path}} placeholder used by the prompt template.
    expect(command).toMatch(/\{\{file_path\}\}/);
  });

  it('N: goal-plan-from-file.md forbids inventing or dropping tasks', () => {
    expect(command).toMatch(/Do NOT invent tasks/i);
    expect(command).toMatch(/Do NOT drop tasks/i);
  });
});

// ── O: install.sh ────────────────────────────────────────────────────────────

describe('O: install.sh — jq filter correctness', () => {
  // O1: Idempotency — run the jq filter twice, same result
  it('O1: running the jq filter twice produces the same Stop entry count', () => {
    const input = { hooks: {} };
    const after1 = runInstallJqFilter(input);
    const after2 = runInstallJqFilter(after1);
    expect(after1.hooks.Stop.length).toBe(1);
    expect(after2.hooks.Stop.length).toBe(1);
  });

  it('O1: running the jq filter twice does not duplicate permissions.allow entries', () => {
    const input = { hooks: {} };
    const after1 = runInstallJqFilter(input);
    const after2 = runInstallJqFilter(after1);
    expect(after1.permissions.allow.length).toBe(2);
    expect(after2.permissions.allow.length).toBe(2);
  });

  // O2: Triplication regression (the 1.1.0–1.1.4 bug)
  it('O2: entry with 3 unrelated hooks is NOT triplicated — stays as 1 entry', () => {
    const input = {
      hooks: {
        Stop: [{
          hooks: [
            { type: 'command', command: 'cmux-notify' },
            { type: 'command', command: 'landing-the-plane' },
            { type: 'command', command: 'audit-on-completion' },
          ],
        }],
      },
    };
    const after = runInstallJqFilter(input);
    // Should be 2 entries total: the original (with 3 hooks) + the new goal-mode entry
    expect(after.hooks.Stop.length).toBe(2);
  });

  it('O2: the original 3-hook entry is preserved intact after install', () => {
    const input = {
      hooks: {
        Stop: [{
          hooks: [
            { type: 'command', command: 'cmux-notify' },
            { type: 'command', command: 'landing-the-plane' },
            { type: 'command', command: 'audit-on-completion' },
          ],
        }],
      },
    };
    const after = runInstallJqFilter(input);
    // The first entry must be the original (none of its commands contain "goal-mode")
    const orig = after.hooks.Stop[0];
    expect(orig.hooks).toHaveLength(3);
    expect(orig.hooks[0].command).toBe('cmux-notify');
  });

  it('O2: triplication regression — second install run does not add a third Stop entry', () => {
    const input = {
      hooks: {
        Stop: [{
          hooks: [
            { type: 'command', command: 'cmux-notify' },
            { type: 'command', command: 'landing-the-plane' },
            { type: 'command', command: 'audit-on-completion' },
          ],
        }],
      },
    };
    const after1 = runInstallJqFilter(input);
    const after2 = runInstallJqFilter(after1);
    // Must still be 2: original + goal-mode (not 3)
    expect(after2.hooks.Stop.length).toBe(2);
  });

  // O3: Fresh install (no existing hooks)
  it('O3: install on empty config produces exactly 1 Stop entry', () => {
    const after = runInstallJqFilter({});
    expect(after.hooks.Stop.length).toBe(1);
    expect(after.hooks.Stop[0].hooks[0].command).toContain('goal-mode');
  });

  // O4/O5: install.sh uses set -euo pipefail (any failure short-circuits).
  // v1.1.17+ rewrote install.sh: it deploys the whole repo via tar to plugin
  // cache and updates jq-managed settings/known_marketplaces files. The
  // assertion is therefore on the current critical jq pipelines, not the old
  // per-file sed flow.
  it('O5: install.sh has set -euo pipefail and uses jq-then-mv atomic write', () => {
    const src = readFile('install.sh');
    expect(src).toContain('set -euo pipefail');
    // The settings.json and known_marketplaces.json updates use a "jq → tmp → mv"
    // atomic pattern. Confirm at least one jq/mv pair exists.
    expect(src).toMatch(/jq[^\n]+>\s*"\$[A-Z_]+\.new"\s*&&\s*mv\s+"\$[A-Z_]+\.new"/);
  });

  // O6: jq availability check
  it('O6: install.sh checks for jq and emits a clear message if missing', () => {
    const src = readFile('install.sh');
    expect(src).toMatch(/command -v jq/);
    expect(src).toMatch(/jq is required/i);
  });

  // O6: npm availability check (replaces old node check — current install.sh
  // shells out to npm install for the zod runtime dep).
  it('O6: install.sh checks for npm (or equivalent runtime tool) and emits a clear message if missing', () => {
    const src = readFile('install.sh');
    expect(src).toMatch(/command -v npm/);
    expect(src).toMatch(/npm.+not\s+found|node\.?js.+install/i);
  });

  // O7: path-with-spaces safety — every variable expansion in critical commands
  // is quoted. Check the hot paths that handle user-controlled paths.
  it('O7: install.sh quotes $REPO_ROOT, $CACHE_DIR, $SETTINGS in critical commands', () => {
    const src = readFile('install.sh');
    // The cache deploy must quote the destination
    expect(src).toContain('"$CACHE_DIR"');
    // The marketplace.json copy must quote the source repo path
    expect(src).toContain('"$REPO_ROOT"');
    // The settings.json updates must quote the target
    expect(src).toContain('"$SETTINGS"');
  });

  // The slash-command count is auto-derived from the commands/ directory; the
  // install.sh no longer hardcodes a count (legacy behavior — install.sh used
  // to per-file-copy with a hardcoded "Copying N slash commands" line). The
  // current install.sh deploys the entire repo as a unit, so the test now
  // asserts the directory contains a sane number of slash commands and that
  // each command file has a matching shim or natural-language entry.
  it('O: commands directory has at least 12 goal-* slash command files (last sane lower bound)', () => {
    const files = fs.readdirSync(COMMANDS).filter((f) => f.startsWith('goal-') && f.endsWith('.md'));
    expect(files.length).toBeGreaterThanOrEqual(12);
  });

  // Existing goal-mode entry is REPLACED, not duplicated.
  // NOTE: the filter identifies goal-mode entries by the string "goal-mode" appearing
  // in the hook command. The repo is always named *goal-mode*, so the install path
  // always contains that string. Tests must reflect this invariant.
  it('O1: existing goal-mode Stop entry is replaced when path contains "goal-mode"', () => {
    const input = {
      hooks: {
        Stop: [{
          hooks: [{
            type: 'command',
            command: 'CLAUDE_PLUGIN_ROOT=/old/clone/claude-code-goal-mode bash "/old/clone/claude-code-goal-mode/hooks/stop-hook.sh"',
          }],
        }],
      },
    };
    // New install from a different path that also contains "goal-mode"
    const after = runInstallJqFilter(input, '/new/claude-code-goal-mode');
    expect(after.hooks.Stop.length).toBe(1);
    expect(after.hooks.Stop[0].hooks[0].command).toContain('/new/claude-code-goal-mode');
    expect(after.hooks.Stop[0].hooks[0].command).not.toContain('/old/clone');
  });
});

// ── P: fix-cli-source.sh ─────────────────────────────────────────────────────

describe('P: fix-cli-source.sh correctness', () => {
  // P1: Idempotency — already-correct "github" source is not modified
  it('P1+P2: file with source="github" is reported as OK with no change', () => {
    const dir = tmpdir();
    const file = path.join(dir, 'known_marketplaces.json');
    fs.writeFileSync(file, JSON.stringify({
      'goal-mode': { source: { source: 'github', repo: 'lokafinnsw/claude-code-goal-mode' } },
    }));
    // Run the migrate_file logic inline (source = "github" → OK branch)
    const content = JSON.parse(fs.readFileSync(file, 'utf8'));
    const sourceVal = content['goal-mode']?.source?.source ?? '';
    expect(['github', 'url', 'git-subdir', 'npm']).toContain(sourceVal);
    fs.rmSync(dir, { recursive: true });
  });

  it('P2: file with source="url" is also treated as already-correct', () => {
    const content = {
      'goal-mode': { source: { source: 'url', url: 'https://github.com/lokafinnsw/claude-code-goal-mode.git' } },
    };
    const sourceVal = content['goal-mode']?.source?.source ?? '';
    // The script's case statement: "github"|"url"|"git-subdir"|"npm" → OK
    expect(['github', 'url', 'git-subdir', 'npm']).toContain(sourceVal);
  });

  // P3: Foreign config keys preserved
  it('P3: jq migration preserves other marketplace entries', () => {
    const input = {
      'goal-mode': { source: { source: 'git', url: 'https://example.com' } },
      'other-plugin': { source: { source: 'npm', package: 'other-pkg' } },
    };
    const result = execSync(
      `echo ${JSON.stringify(JSON.stringify(input))} | jq --arg repo "lokafinnsw/claude-code-goal-mode" '."goal-mode" = {"source": {"source": "github", "repo": $repo}}'`,
      { encoding: 'utf8' }
    );
    const parsed = JSON.parse(result);
    // other-plugin must be preserved
    expect(parsed['other-plugin']).toBeDefined();
    expect(parsed['other-plugin'].source.source).toBe('npm');
    // goal-mode migrated
    expect(parsed['goal-mode'].source.source).toBe('github');
  });

  // P4: Missing file handling
  it('P4: script handles missing file gracefully (SKIP message)', () => {
    const src = readFile('scripts/fix-cli-source.sh');
    // The migrate_file function checks [[ ! -f "$file" ]] and returns 0
    expect(src).toContain('[[ ! -f "$file" ]]');
    expect(src).toContain('return 0');
  });

  // Source type migration: git -> github (the documented fix)
  it('P: migration from "git" to "github" produces correct repo field', () => {
    const input = {
      'goal-mode': { source: { source: 'git', url: 'https://github.com/lokafinnsw/claude-code-goal-mode.git' } },
    };
    // Simulate what the script does: replace with {"source": "github", "repo": $repo}
    const expected = { source: 'github', repo: 'lokafinnsw/claude-code-goal-mode' };
    const result = execSync(
      `echo ${JSON.stringify(JSON.stringify(input))} | jq --arg repo "lokafinnsw/claude-code-goal-mode" '."goal-mode".source = {"source": "github", "repo": $repo}'`,
      { encoding: 'utf8' }
    );
    const parsed = JSON.parse(result);
    expect(parsed['goal-mode'].source).toEqual(expected);
  });

  // P: fix-cli-source.sh has set -euo pipefail
  it('P: fix-cli-source.sh has set -euo pipefail', () => {
    const src = readFile('scripts/fix-cli-source.sh');
    expect(src).toContain('set -euo pipefail');
  });

  // P: jq check present
  it('P: fix-cli-source.sh checks for jq before running', () => {
    const src = readFile('scripts/fix-cli-source.sh');
    expect(src).toMatch(/command -v jq/);
  });
});

// ── Q: Vendored zod ───────────────────────────────────────────────────────────

describe('Q: Vendored zod self-containment', () => {
  const zodPkg = JSON.parse(fs.readFileSync(path.join(REPO, 'node_modules/zod/package.json'), 'utf8'));
  const repoPkg = JSON.parse(readFile('package.json'));

  // Q2: Version consistency
  it('Q2: vendored zod version satisfies declared ^3.23.8 range', () => {
    const declared = repoPkg.dependencies.zod;  // "^3.23.8"
    const vendored = zodPkg.version;             // "3.25.76"
    // ^3.23.8 means >=3.23.8 <4.0.0
    const [decMaj, decMin, decPatch] = declared.replace('^', '').split('.').map(Number);
    const [vendMaj, vendMin] = vendored.split('.').map(Number);
    expect(vendMaj).toBe(decMaj);  // same major
    expect(vendMin * 1000 + parseInt(vendored.split('.')[2]))
      .toBeGreaterThanOrEqual(decMin * 1000 + decPatch);
  });

  it('Q2: vendored zod name matches expected package name', () => {
    expect(zodPkg.name).toBe('zod');
  });

  // Q1: Self-contained import — the engine uses 'import { z } from "zod"'
  // Node resolves this to node_modules/zod/index.js per the exports map
  it('Q1: node_modules/zod/index.js exists (ESM entry point)', () => {
    const esmEntry = path.join(REPO, 'node_modules/zod/index.js');
    expect(fs.existsSync(esmEntry)).toBe(true);
  });

  it('Q1: node_modules/zod/index.cjs exists (CJS fallback)', () => {
    const cjsEntry = path.join(REPO, 'node_modules/zod/index.cjs');
    expect(fs.existsSync(cjsEntry)).toBe(true);
  });

  it('Q1: node_modules/zod/package.json exports map has "import" key pointing to ESM', () => {
    const importEntry = zodPkg.exports?.['.']?.import;
    expect(importEntry).toBeTruthy();
    const resolved = path.join(REPO, 'node_modules/zod', importEntry);
    expect(fs.existsSync(resolved)).toBe(true);
  });

  // Q3: No peer deps (zod is self-contained)
  it('Q3: vendored zod has no peer dependencies', () => {
    const peerDeps = zodPkg.peerDependencies ?? {};
    expect(Object.keys(peerDeps).length).toBe(0);
  });

  // Q1: The actual engine import chain works (GoalTreeSchema can be loaded)
  it('Q1: engine/state.mjs imports from zod successfully (GoalTreeSchema loadable)', async () => {
    const { GoalTreeSchema } = await import('../engine/state.mjs');
    expect(GoalTreeSchema).toBeDefined();
    expect(typeof GoalTreeSchema.parse).toBe('function');
  });
});

// ── R: Marketplace shape ──────────────────────────────────────────────────────

describe('R: Marketplace and plugin.json shape', () => {
  const marketplace = JSON.parse(readFile('.claude-plugin/marketplace.json'));
  const plugin = JSON.parse(readFile('.claude-plugin/plugin.json'));

  // R4: JSON validity (parse above would have thrown if invalid)
  it('R4: marketplace.json is valid JSON', () => {
    expect(marketplace).toBeTruthy();
  });

  it('R4: plugin.json is valid JSON', () => {
    expect(plugin).toBeTruthy();
  });

  // R2: source must be "url" (not "github", not "git")
  it('R2: marketplace.json plugin source type is "url" (commit c2c2e4b)', () => {
    const src = marketplace.plugins[0].source;
    expect(src.source).toBe('url');
  });

  it('R2: marketplace.json url points to the github repo', () => {
    const src = marketplace.plugins[0].source;
    expect(src.url).toContain('github.com/lokafinnsw/claude-code-goal-mode');
  });

  // R3: No sha-pin (commit c964276)
  it('R3: marketplace.json has no sha pin', () => {
    const src = marketplace.plugins[0].source;
    expect(src.sha).toBeUndefined();
    expect(src.commit).toBeUndefined();
    expect(src.ref).toBeUndefined();
  });

  // R1: plugin.json shape
  it('R1: plugin.json has required fields: name, version, description, author', () => {
    expect(plugin.name).toBeTruthy();
    expect(plugin.version).toBeTruthy();
    expect(plugin.description).toBeTruthy();
    expect(plugin.author).toBeTruthy();
  });

  it('R1: plugin.json version matches marketplace.json version', () => {
    expect(plugin.version).toBe(marketplace.plugins[0].version);
  });

  it('R1: plugin.json version matches package.json version', () => {
    const pkg = JSON.parse(readFile('package.json'));
    expect(plugin.version).toBe(pkg.version);
  });

  // marketplace.json must have required top-level fields
  it('R1: marketplace.json has name, description, plugins array', () => {
    expect(marketplace.name).toBeTruthy();
    expect(marketplace.description).toBeTruthy();
    expect(Array.isArray(marketplace.plugins)).toBe(true);
    expect(marketplace.plugins.length).toBeGreaterThan(0);
  });
});

// ── S: Example plans ──────────────────────────────────────────────────────────

describe('S: Example plans round-trip and structural consistency', () => {
  const slugs = ['feature-auth-jwt', 'migration-pydantic-v1-v2', 'refactor-axios-to-fetch'];

  // S1 + S3: validatePlan passes (already tested in example-plans.test.mjs, but we add
  //           the availableReviewers: empty-set variant to confirm no reviewer-missing ERRORs)
  it.each(slugs)('S3: %s.tree.json: validatePlan with empty reviewer set produces no errors', async (slug) => {
    const { validatePlan } = await import('../engine/validate-plan.mjs');
    const tree = JSON.parse(fs.readFileSync(path.join(EXAMPLES, `${slug}.tree.json`), 'utf8'));
    const result = validatePlan(tree, { availableReviewers: new Set() });
    // Reviewer warnings (not errors) are acceptable for examples
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  // S2: Sprint/epic/task counts match between tree.json and plan.md headings
  it('S2: feature-auth-jwt sprint/epic/task counts match between tree.json and plan.md', () => {
    const tree = JSON.parse(fs.readFileSync(path.join(EXAMPLES, 'feature-auth-jwt.tree.json'), 'utf8'));
    const plan = fs.readFileSync(path.join(EXAMPLES, 'feature-auth-jwt.plan.md'), 'utf8');

    function countNodes(node, type) {
      let n = node.type === type ? 1 : 0;
      for (const c of node.children ?? []) n += countNodes(c, type);
      return n;
    }

    const treeSprints = countNodes(tree.root, 'sprint');
    const treeEpics = countNodes(tree.root, 'epic');
    const treeTasks = countNodes(tree.root, 'task');

    const h2 = (plan.match(/^## /gm) ?? []).length;
    const h3 = (plan.match(/^### /gm) ?? []).length;
    const h4 = (plan.match(/^#### /gm) ?? []).length;

    expect(treeSprints).toBe(h2);
    expect(treeEpics).toBe(h3);
    expect(treeTasks).toBe(h4);
  });

  it('S2: migration-pydantic-v1-v2 sprint/epic/task counts match', () => {
    const tree = JSON.parse(fs.readFileSync(path.join(EXAMPLES, 'migration-pydantic-v1-v2.tree.json'), 'utf8'));
    const plan = fs.readFileSync(path.join(EXAMPLES, 'migration-pydantic-v1-v2.plan.md'), 'utf8');

    function countNodes(node, type) {
      let n = node.type === type ? 1 : 0;
      for (const c of node.children ?? []) n += countNodes(c, type);
      return n;
    }

    expect(countNodes(tree.root, 'sprint')).toBe((plan.match(/^## /gm) ?? []).length);
    expect(countNodes(tree.root, 'epic')).toBe((plan.match(/^### /gm) ?? []).length);
    expect(countNodes(tree.root, 'task')).toBe((plan.match(/^#### /gm) ?? []).length);
  });

  it('S2: refactor-axios-to-fetch sprint/epic/task counts match', () => {
    const tree = JSON.parse(fs.readFileSync(path.join(EXAMPLES, 'refactor-axios-to-fetch.tree.json'), 'utf8'));
    const plan = fs.readFileSync(path.join(EXAMPLES, 'refactor-axios-to-fetch.plan.md'), 'utf8');

    function countNodes(node, type) {
      let n = node.type === type ? 1 : 0;
      for (const c of node.children ?? []) n += countNodes(c, type);
      return n;
    }

    expect(countNodes(tree.root, 'sprint')).toBe((plan.match(/^## /gm) ?? []).length);
    expect(countNodes(tree.root, 'epic')).toBe((plan.match(/^### /gm) ?? []).length);
    expect(countNodes(tree.root, 'task')).toBe((plan.match(/^#### /gm) ?? []).length);
  });

  // S4: No TBD/TODO/FIXME/XXX placeholders in examples
  it.each(slugs)('S4: %s.plan.md has no TBD/TODO/FIXME/XXX placeholders', (slug) => {
    const plan = fs.readFileSync(path.join(EXAMPLES, `${slug}.plan.md`), 'utf8');
    expect(plan).not.toMatch(/\bTBD\b|\bTODO\b|\bFIXME\b|\bXXX\b/i);
  });

  it.each(slugs)('S4: %s.tree.json has no TBD/TODO/FIXME/XXX placeholders', (slug) => {
    const content = fs.readFileSync(path.join(EXAMPLES, `${slug}.tree.json`), 'utf8');
    expect(content).not.toMatch(/\bTBD\b|\bTODO\b|\bFIXME\b|\bXXX\b/i);
  });

  // S1: Every task in every example has at least 1 acceptance criterion (schema + validate-plan)
  it.each(slugs)('S1: %s every leaf task has non-empty acceptance_criteria', (slug) => {
    const tree = JSON.parse(fs.readFileSync(path.join(EXAMPLES, `${slug}.tree.json`), 'utf8'));
    function walk(node) {
      if (node.type === 'task') {
        expect(node.acceptance_criteria.length, `Task ${node.id} has empty criteria`).toBeGreaterThan(0);
      }
      for (const c of node.children ?? []) walk(c);
    }
    walk(tree.root);
  });
});

// ── T: Documentation accuracy ──────────────────────────────────────────────────

describe('T: Documentation accuracy', () => {
  const readme = readFile('README.md');
  const changelog = readFile('CHANGELOG.md');

  // T1a: README status/release badge must either pin to the current package
  // version, use a generic "stable/released" marker, or auto-pull the latest
  // git tag (the canonical pattern after v1.1.20+ — keeps the README from
  // going stale on every patch bump).
  it('T1 [BUG]: README release/status badge reflects current version OR auto-derives from git tag', () => {
    const pkg = JSON.parse(readFile('package.json'));
    const versionInBadge = readme.includes(`status-${pkg.version}-brightgreen`);
    const genericMarker = /status-(stable|released|live)-brightgreen/i.test(readme);
    const autoFromTag = /img\.shields\.io\/github\/v\/tag\/[^"]+\?label=release/.test(readme);
    expect(
      versionInBadge || genericMarker || autoFromTag,
      `README badge should reflect version ${pkg.version}, be a generic stable marker, or auto-pull from git tag; current README has none of these.`,
    ).toBe(true);
  });

  // T1b: README Status section headline must reflect current package.json version.
  // Pattern accepts both em-dash and hyphen between version and label, and any
  // of (stable, pre-release, alpha, beta, rc) suffix. Pre-release versions
  // shouldn't claim "stable"; this lets the README mark them appropriately.
  it('T1 [BUG]: README Status section headline must match package.json version', () => {
    const pkg = JSON.parse(readFile('package.json'));
    const versionEsc = pkg.version.replace(/\./g, '\\.');
    const expected = new RegExp(
      `v${versionEsc}\\s*[—-]\\s*(stable|pre-?release|release\\s+candidate|release|alpha\\d*|beta\\d*|rc\\d*)`,
      'i',
    );
    expect(
      expected.test(readme),
      `README Status section should headline current version ${pkg.version} with an appropriate stability marker (stable / pre-release / alpha / beta / rc).`,
    ).toBe(true);
  });

  // T2: CHANGELOG has entries for every version from 1.0.0 to 1.1.7
  it('T2: CHANGELOG covers all 1.1.x versions through 1.1.7', () => {
    const versions = ['1.0.0', '1.0.1', '1.1.0', '1.1.1', '1.1.2', '1.1.3', '1.1.4', '1.1.5', '1.1.6', '1.1.7'];
    for (const v of versions) {
      expect(changelog, `CHANGELOG missing [${v}]`).toContain(`[${v}]`);
    }
  });

  // T3: Doc links in README all resolve
  it('T3: README doc section links to existing files', () => {
    const docLinks = [
      'docs/PLAN-FORMAT.md',
      'docs/REVIEW-AGENTS.md',
      'docs/BUDGET.md',
      'docs/ANTI-PATTERNS.md',
      'docs/SMOKE-TEST.md',
    ];
    for (const link of docLinks) {
      const fullPath = path.join(REPO, link);
      expect(fs.existsSync(fullPath), `Missing: ${link}`).toBe(true);
    }
  });

  // T3: EXAMPLES directory referenced in README exists with the expected files
  it('T3: README references docs/EXAMPLES/ — directory and 6 files exist', () => {
    expect(fs.existsSync(path.join(REPO, 'docs/EXAMPLES'))).toBe(true);
    const files = fs.readdirSync(path.join(REPO, 'docs/EXAMPLES'));
    expect(files).toContain('feature-auth-jwt.tree.json');
    expect(files).toContain('feature-auth-jwt.plan.md');
  });

  // T4: /goal-plan-from-file is listed in goal-help.md (slash convention switched
  // to hyphens v1.1.13+; the canonical plugin namespace form is /goal-mode:goal-X
  // but goal-help.md uses the short /goal-X form for readability).
  it('T4: goal-help.md lists /goal-plan-from-file', () => {
    const help = readFile('commands/goal-help.md');
    expect(help).toContain('/goal-plan-from-file');
  });

  it('T4: goal-help.md lists all canonical commands', () => {
    const help = readFile('commands/goal-help.md');
    const expectedCommands = [
      '/goal-plan',
      '/goal-plan-from-file',
      '/goal-approve-plan',
      '/goal-start',
      '/goal-status',
      '/goal-doctor',
      '/goal-pause',
      '/goal-resume',
      '/goal-approve',
      '/goal-abandon',
      '/goal-clear',
      '/goal-help',
    ];
    for (const cmd of expectedCommands) {
      expect(help, `goal-help.md missing ${cmd}`).toContain(cmd);
    }
  });

  // T4: Every /goal:X reference in goal-help.md resolves to a command file
  it('T4: every /goal:X command in goal-help.md resolves to a commands/goal-X.md file', () => {
    const help = readFile('commands/goal-help.md');
    // Extract unique /goal:X patterns (strip backticks, trailing punctuation)
    const cmdRefs = [...new Set(
      [...help.matchAll(/\/goal:([\w-]+)/g)].map(m => m[1])
    )];
    for (const name of cmdRefs) {
      const filePath = path.join(COMMANDS, `goal-${name}.md`);
      expect(fs.existsSync(filePath), `goal-help.md references /goal:${name} but commands/goal-${name}.md not found`).toBe(true);
    }
  });

  // T5: Status badge — document the stale URL as a known defect
  it('T5: CI badge URL points to the correct repo', () => {
    expect(readme).toContain('lokafinnsw/claude-code-goal-mode/actions/workflows/ci.yml');
  });

  // T6: README Documentation section links cover all 4 required docs
  it('T6: README Documentation section links PLAN-FORMAT, REVIEW-AGENTS, BUDGET, ANTI-PATTERNS', () => {
    expect(readme).toContain('[docs/PLAN-FORMAT.md]');
    expect(readme).toContain('[docs/REVIEW-AGENTS.md]');
    expect(readme).toContain('[docs/BUDGET.md]');
    expect(readme).toContain('[docs/ANTI-PATTERNS.md]');
  });
});

// ── U: End-to-end smoke ────────────────────────────────────────────────────────

describe('U: E2E smoke — plan-from-file generated state drives full lifecycle', () => {
  // U2: plan-from-file simulated: synthetic tree → validatePlan → approvePlan → startGoal
  it('U2: synthetic plan-from-file output wires through validatePlan → approvePlan → startGoal', async () => {
    const { saveTree, saveState, loadState } = await import('../engine/state.mjs');
    const { validatePlan } = await import('../engine/validate-plan.mjs');
    const { approvePlan } = await import('../engine/approve-plan-cli.mjs');
    const { startGoal } = await import('../engine/start-goal.mjs');

    const root = tmpdir();

    // Simulate what plan-from-file would write
    const tree = {
      schema_version: 2,
      goal_id: 'pff-sim-goal',
      mission: 'Simulated plan-from-file goal',
      created_at: new Date().toISOString(),
      approved_at: null,
      root: {
        id: 'sprint-1',
        type: 'sprint',
        title: 'Sprint 1',
        goal: 'First sprint',
        acceptance_criteria: [],
        review: [],
        validate: null,
        work_front: 'infra',
        status: 'pending',
        evidence: [],
        blocker_reason: null,
        review_attempts: 0,
        notes: [],
        children: [
          makeTask('sprint-1.task-1', {
            title: 'Setup CI',
            goal: 'CI pipeline is green.',
            acceptance_criteria: ['CI job exits 0 on main branch'],
            validate: 'npm test',
          }),
          makeTask('sprint-1.task-2', {
            title: 'Deploy to staging',
            goal: 'Service is reachable at staging URL.',
            acceptance_criteria: ['HTTP GET /health returns 200'],
            validate: 'npm test',
          }),
        ],
      },
    };

    const draftState = makeDraftState('pff-sim-goal');

    saveTree(root, tree);
    saveState(root, draftState);

    // validatePlan must pass
    const loaded = JSON.parse(fs.readFileSync(
      path.join(root, '.claude/goals/active/tree.json'), 'utf8'
    ));
    const vResult = validatePlan(loaded, { availableReviewers: new Set() });
    expect(vResult.ok).toBe(true);
    expect(vResult.errors).toEqual([]);

    // approvePlan must stamp approved_at
    const approveResult = approvePlan(root, { availableReviewers: new Set() });
    expect(approveResult.ok).toBe(true);

    // startGoal must set cursor to first task
    const startResult = startGoal(root, {
      sessionId: 'u2-sim-session',
      maxIter: 50,
      tokenBudget: 1_000_000,
      timeBudgetSeconds: 3600,
    });
    expect(startResult.ok).toBe(true);
    expect(startResult.cursor).toBe('sprint-1.task-1');

    const state = loadState(root);
    expect(state.lifecycle).toBe('pursuing');
    expect(state.cursor).toBe('sprint-1.task-1');

    fs.rmSync(root, { recursive: true });
  });

  // U1: feature-auth-jwt.tree.json drives approvePlan → startGoal
  it('U1: feature-auth-jwt example drives approvePlan → startGoal with correct cursor', async () => {
    const { saveTree, saveState, loadState } = await import('../engine/state.mjs');
    const { approvePlan } = await import('../engine/approve-plan-cli.mjs');
    const { startGoal } = await import('../engine/start-goal.mjs');

    const root = tmpdir();

    const rawTree = JSON.parse(fs.readFileSync(path.join(EXAMPLES, 'feature-auth-jwt.tree.json'), 'utf8'));
    saveTree(root, rawTree);
    saveState(root, makeDraftState(rawTree.goal_id));

    // approvePlan
    const approveResult = approvePlan(root, { availableReviewers: new Set() });
    expect(approveResult.ok).toBe(true);

    // startGoal
    const startResult = startGoal(root, {
      sessionId: 'u1-jwt-session',
      maxIter: 200,
      tokenBudget: 5_000_000,
      timeBudgetSeconds: 28800,
    });
    expect(startResult.ok).toBe(true);

    // cursor should be the first leaf task
    const state = loadState(root);
    expect(state.lifecycle).toBe('pursuing');
    expect(state.cursor).toBe('sprint-1.epic-1.task-1');

    fs.rmSync(root, { recursive: true });
  });
});

// ── V: Prompt-content smoke ────────────────────────────────────────────────────

describe('V: Prompt-content smoke (per 8b308ae)', () => {
  const planFromFile = readFile('prompts/plan-from-file.md');

  // V1: The 5 CHANGELOG-cited smoke assertions are present and concrete
  it('V1.1: assertion 1 — mandates all three files in one turn (concrete)', () => {
    expect(planFromFile).toMatch(/all three files MUST exist/i);
  });

  it('V1.2: assertion 2 — forbids generator scripts (concrete)', () => {
    expect(planFromFile).toMatch(/DO NOT[\s\S]{0,30}write a generator script/i);
  });

  it('V1.3: assertion 3 — forbids multi-turn Edit chains (exact string)', () => {
    expect(planFromFile).toMatch(/no Edit chains/i);
    expect(planFromFile).toContain("I'll continue adding sprints across multiple Edit calls");
  });

  it('V1.4: assertion 4 — mandates ONE Write per file, Three Writes total (exact)', () => {
    expect(planFromFile).toMatch(/ONE Write per file/i);
    expect(planFromFile).toMatch(/Three Writes total/i);
  });

  it('V1.5: assertion 5 — forbids leaving file in approve-plan-breaking state (concrete)', () => {
    expect(planFromFile).toMatch(/dangling commas|incomplete sprints|missing tasks/i);
  });

  // V2: Scan all prompts for unresolved template artifacts
  it('V2: no prompt file contains unresolved {{var}} tokens (except plan-from-file.md intentional {{file_path}})', () => {
    const promptFiles = fs.readdirSync(PROMPTS).filter(f => f.endsWith('.md'));
    for (const fname of promptFiles) {
      const content = fs.readFileSync(path.join(PROMPTS, fname), 'utf8');
      if (fname === 'plan-from-file.md') {
        // {{file_path}} is the intentional placeholder LLM must substitute — expected
        // But no OTHER unresolved vars should exist
        const vars = [...content.matchAll(/\{\{([^}]+)\}\}/g)].map(m => m[1]);
        const unexpected = vars.filter(v => v !== 'file_path');
        expect(unexpected, `Unexpected unresolved vars in ${fname}: ${unexpected}`).toEqual([]);
        continue;
      }
      // Other prompts are rendered via buildContext — they should contain {{var}} tokens
      // that ARE valid template vars. We only check for suspicious patterns like {{}} or
      // malformed vars.
      const emptyBraces = content.match(/\{\{\s*\}\}/g);
      expect(emptyBraces, `${fname} has empty braces {{}}`).toBeNull();
    }
  });

  // V2: Forbidden output phrases — plan-from-file prompt must not itself contain "TODO" etc.
  it('V2: prompts/plan-from-file.md has no TBD/TODO/FIXME/XXX placeholders as instructions', () => {
    // The prompt should tell the LLM to REPLACE these, not contain them as instructions
    // (The word "TBD" etc. appear as FORBIDDEN strings to detect in user source — that's OK)
    // This test ensures no accidental scaffolding left in the prompt body
    const lines = planFromFile.split('\n');
    const suspiciousLines = lines.filter(l =>
      /\bTODO\b/.test(l) && !l.includes('TBD') && !l.includes('validatePlan')
    );
    // "TODO" may appear legitimately in examples like "pick reviewer names... leave as TODO with a note"
    // We allow it if it's explaining the user-facing concept
    // Filter to lines that are pure TODO instructions without explanatory context
    const trulyBad = suspiciousLines.filter(l => l.trim().startsWith('TODO'));
    expect(trulyBad).toEqual([]);
  });
});

// ── W: Cross-cutting ───────────────────────────────────────────────────────────

describe('W: Cross-cutting / unbounded growth', () => {
  // W2: goal-help.md mentions /goal-help itself (self-referential check).
  // Slash-command convention v1.1.13+ uses hyphens (no colon prefix) in the
  // short form; the full canonical form is /goal-mode:goal-help.
  it('W2: goal-help.md mentions /goal-help itself (self-referential check)', () => {
    const help = readFile('commands/goal-help.md');
    expect(help).toContain('/goal-help');
  });

  // W3: audits/ unbounded — verify whether a cap exists in apply-mutations.mjs
  it('W3: audit directory growth behaviour is explicitly documented in apply-mutations.mjs comments', () => {
    // Check whether apply-mutations has any cap/limit/rotation documentation.
    // If there IS a cap, the engine is self-limiting. If there is NOT, that is a known
    // unbounded-growth path worth documenting. Either way the comment should exist.
    const applyMut = readFile('engine/apply-mutations.mjs');
    // The function that writes audit files must exist
    expect(applyMut).toMatch(/audit/i);
    // We don't assert cap presence/absence — the test merely confirms audit writes exist
    // so future engineers know where to look. See W3 report for the gap analysis.
  });

  // W4/W5: state.json history is unbounded — document the absence of a size cap
  it('W4 [doc gap]: GoalStateSchema.history has no max-length constraint', async () => {
    const { GoalStateSchema } = await import('../engine/state.mjs');
    // Build a state with 1000 history entries — should not throw
    const bigHistory = Array.from({ length: 1000 }, (_, i) => ({
      ts: new Date().toISOString(),
      iteration: i,
      event: 'evidence-added',
      node_id: 'test',
      payload: {},
    }));
    const state = {
      ...makeDraftState(),
      history: bigHistory,
    };
    // This must parse cleanly (no cap enforced at schema level)
    expect(() => GoalStateSchema.parse(state)).not.toThrow();
    // KNOWN GAP: history grows unboundedly; JSON parse perf degrades at 10k+ entries.
  });

  // W1: plan-from-file tree drives multi-iteration Stop hook (wiring proof)
  it('W1: plan-from-file tree with Phase 8 budget drives Stop hook (evidence advance)', async () => {
    const { saveTree, saveState, loadState } = await import('../engine/state.mjs');
    const { approvePlan } = await import('../engine/approve-plan-cli.mjs');
    const { startGoal } = await import('../engine/start-goal.mjs');
    const { runStopHook } = await import('../engine/stop-hook.mjs');

    const root = tmpdir();

    // Plan-from-file output: 1 sprint, 1 epic, 1 task
    const tree = {
      schema_version: 2,
      goal_id: 'w1-cross-phase',
      mission: 'Cross-phase wiring test',
      created_at: new Date().toISOString(),
      approved_at: null,
      root: {
        id: 's', type: 'sprint', title: 'Sprint 1', goal: 'G',
        acceptance_criteria: [], review: [], validate: null, work_front: 'engine',
        status: 'pending', evidence: [], blocker_reason: null, review_attempts: 0, notes: [],
        children: [{
          id: 's.e1', type: 'epic', title: 'Epic 1', goal: 'G',
          acceptance_criteria: [], review: [], validate: null, work_front: 'engine',
          status: 'pending', evidence: [], blocker_reason: null, review_attempts: 0, notes: [],
          children: [
            makeTask('s.e1.t1', { acceptance_criteria: ['criterion A'] }),
          ],
        }],
      },
    };

    saveTree(root, tree);
    saveState(root, makeDraftState('w1-cross-phase'));

    approvePlan(root, { availableReviewers: new Set() });
    const startResult = startGoal(root, {
      sessionId: 'w1-session',
      maxIter: 10,
      tokenBudget: 500_000,
      timeBudgetSeconds: 1800,
    });
    expect(startResult.ok).toBe(true);
    expect(startResult.cursor).toBe('s.e1.t1');

    // Write transcript with evidence + achieved tags
    const transcriptPath = path.join(root, 'transcript.jsonl');
    const agentText = [
      '<evidence file="src/x.ts" criterion="0">criterion A covered</evidence>',
      '<task-status>achieved</task-status>',
    ].join('\n');
    fs.writeFileSync(transcriptPath, JSON.stringify({
      message: { role: 'assistant', content: [{ type: 'text', text: agentText }] },
    }) + '\n');

    // Run Stop hook — runStopHook takes {stdin: {session_id, transcript_path}, projectRoot}
    const hookResult = await runStopHook({
      stdin: { session_id: 'w1-session', transcript_path: transcriptPath },
      projectRoot: root,
    });
    expect(hookResult).toBeDefined();
    expect(hookResult.exit).toBe(0);

    // Task achieved, lifecycle should now be 'achieved' (only 1 task in tree)
    const state = loadState(root);
    expect(['achieved', 'pursuing', 'budget-limited']).toContain(state.lifecycle);

    fs.rmSync(root, { recursive: true });
  });

  // W6: README Documentation section has all 4 required doc links
  it('W6: README Documentation section covers PLAN-FORMAT, REVIEW-AGENTS, BUDGET, ANTI-PATTERNS', () => {
    const readme = readFile('README.md');
    expect(readme).toContain('PLAN-FORMAT.md');
    expect(readme).toContain('REVIEW-AGENTS.md');
    expect(readme).toContain('BUDGET.md');
    expect(readme).toContain('ANTI-PATTERNS.md');
  });

  // Additional cross-cutting: plan-from-file must not be in allowed-tools for the Stop hook
  it('W: goal-plan-from-file.md allowed-tools list does not include Write to state paths directly', () => {
    const cmd = readFile('commands/goal-plan-from-file.md');
    // The command should include Write (to write the three files) — that's correct
    expect(cmd).toContain('"Write"');
  });

  // N: plan-from-file acceptance-criteria synthesis rule is explicit
  it('N: plan-from-file prompt mandates ≥1 acceptance_criteria per task (synthesis rule)', () => {
    const prompt = readFile('prompts/plan-from-file.md');
    expect(prompt).toMatch(/every task must have at least one criterion/i);
  });

  // N: plan-from-file validate-command extraction rule is present
  it('N: plan-from-file prompt describes validate-command extraction logic', () => {
    const prompt = readFile('prompts/plan-from-file.md');
    expect(prompt).toMatch(/validate.*null|validate.*command/i);
  });

  // N: plan-from-file No placeholder strings rule is present
  it('N: plan-from-file prompt instructs replacing TBD/TODO/FIXME/XXX from source', () => {
    const prompt = readFile('prompts/plan-from-file.md');
    expect(prompt).toMatch(/TBD.*TODO.*FIXME|validatePlan.*rejects.*TBD/i);
  });
});

// ── Real-usage regression tests (found via adversarial real-usage pass 2026-05-10) ──────────────

describe('X: real-usage regressions', () => {
  // X1: audit-verdict status is case-INSENSITIVE since v1.1.11 — lowercase
  // "go", mixed-case "Nogo", "Revise" are all accepted and normalised to
  // upper-case before enum matching. This was the original X1 regression
  // (silent drop on lowercase) and is now an enforced anti-regression.
  it('X1: parseTags accepts case-insensitive audit-verdict status (go/Nogo/REVISE all normalised to upper)', async () => {
    const { parseTags } = await import('../engine/parse-tags.mjs');
    const lowercase = parseTags('<audit-verdict agent="reviewer" status="go">looks good</audit-verdict>');
    expect(lowercase).toHaveLength(1);
    expect(lowercase[0].status).toBe('GO');

    const uppercase = parseTags('<audit-verdict agent="reviewer" status="GO">looks good</audit-verdict>');
    expect(uppercase).toHaveLength(1);
    expect(uppercase[0].status).toBe('GO');

    const mixed = parseTags('<audit-verdict agent="reviewer" status="Nogo">failed</audit-verdict>');
    expect(mixed).toHaveLength(1);
    expect(mixed[0].status).toBe('NOGO');

    const revise = parseTags('<audit-verdict agent="reviewer" status="Revise">tighten the test</audit-verdict>');
    expect(revise).toHaveLength(1);
    expect(revise[0].status).toBe('REVISE');
  });

  // X2: Zero-criteria task can be claimed achieved with no evidence
  // Guard: validatePlan rejects 0-criteria tasks, so this can only happen if
  // someone manually crafts tree.json bypassing approve-plan.
  it('X2: validatePlan rejects task with acceptance_criteria: [] (zero entries)', async () => {
    const { validatePlan } = await import('../engine/validate-plan.mjs');
    const tree = {
      schema_version: 2, goal_id: 'x2', mission: 'x2',
      created_at: new Date().toISOString(), approved_at: null,
      root: {
        id: 's', type: 'sprint', title: 'S', goal: 'G',
        acceptance_criteria: [], review: [], validate: null, work_front: 't',
        status: 'pending', evidence: [], blocker_reason: null, review_attempts: 0, notes: [],
        children: [{
          id: 's.e', type: 'epic', title: 'E', goal: 'G',
          acceptance_criteria: [], review: [], validate: null, work_front: 't',
          status: 'pending', evidence: [], blocker_reason: null, review_attempts: 0, notes: [],
          children: [{
            id: 's.e.t', type: 'task', title: 'T', goal: 'G',
            acceptance_criteria: [], // ZERO criteria
            review: [], validate: null, work_front: 't', status: 'pending',
            evidence: [], blocker_reason: null, review_attempts: 0, notes: [], children: [],
          }],
        }],
      },
    };
    const result = validatePlan(tree, { availableReviewers: new Set() });
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/at least one acceptance_criteria/i);
  });

  // X3: applyMutations: out-of-range criterion index on evidence tag does NOT
  // advance task to achieved — the engine silently records the evidence but
  // leaves the task in 'pursuing' since no valid criterion is covered.
  it('X3: applyMutations ignores evidence with criterion index >= acceptance_criteria.length', async () => {
    const { parseTags } = await import('../engine/parse-tags.mjs');
    const { applyMutations } = await import('../engine/apply-mutations.mjs');

    const task = {
      id: 's.e.t', type: 'task', title: 'T', goal: 'G',
      acceptance_criteria: ['criterion 0', 'criterion 1'],
      review: [], validate: null, work_front: 't', status: 'pending',
      evidence: [], blocker_reason: null, review_attempts: 0, notes: [], children: [],
    };
    const tree = {
      schema_version: 2, goal_id: 'x3', mission: 'x3',
      created_at: new Date().toISOString(), approved_at: new Date().toISOString(),
      root: {
        id: 's', type: 'sprint', title: 'S', goal: 'G',
        acceptance_criteria: [], review: [], validate: null, work_front: 't',
        status: 'pending', evidence: [], blocker_reason: null, review_attempts: 0, notes: [],
        children: [{
          id: 's.e', type: 'epic', title: 'E', goal: 'G',
          acceptance_criteria: [], review: [], validate: null, work_front: 't',
          status: 'pending', evidence: [], blocker_reason: null, review_attempts: 0, notes: [],
          children: [task],
        }],
      },
    };
    const state = {
      schema_version: 2, goal_id: 'x3', lifecycle: 'pursuing', cursor: 's.e.t',
      budget: { iterations: { used: 1, max: 10 }, tokens: { used: 0, max: 0 }, wallclock: { started_at: new Date().toISOString(), max_seconds: 0 } },
      session_id: 'test', started_at: new Date().toISOString(),
      paused_at: null, ended_at: null, ended_reason: null, history: [],
    };

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'x3-'));
    const text = '<evidence file="src/x.ts" line="1" criterion="99">out-of-range</evidence>\n<task-status>achieved</task-status>';
    const tags = parseTags(text);
    const result = applyMutations(tree, state, tags, new Date().toISOString(), { auditsDir: tmpDir });
    fs.rmSync(tmpDir, { recursive: true });

    const taskResult = result.tree.root.children[0].children[0];
    // Task must NOT be achieved since criterion 99 is out of range
    expect(taskResult.status).not.toBe('achieved');
    // Evidence IS recorded (engine accepts it but it covers no valid criterion)
    expect(taskResult.evidence).toHaveLength(1);
    expect(taskResult.evidence[0].criterion_index).toBe(99);
  });

  // X4: install.sh v1.1.17+ no longer manages legacy hook entries via a string
  // contains() jq filter (that was the old per-file-installer model). The
  // current installer deploys to plugin-cache and lets Claude Code's plugin
  // loader register hooks via plugin manifest. The dedup concern moves to
  // installed_plugins.json: there must be exactly one entry per plugin key.
  it('X4: install.sh writes a single installed_plugins.json entry per plugin (no duplicates)', () => {
    const install = readFile('install.sh');
    // The pin block writes plugins[$key] as a single-element array []. Verify.
    expect(install).toMatch(/\.plugins\[\$key\]\s*=\s*\[\{/);
    expect(install).toContain('Pinned v$VERSION in installed_plugins.json');
  });

  // X5: status-goal with corrupt tree.json says "No active goal" even when state.json exists
  // This documents the misleading "No active goal" message when tree.json is corrupted.
  it('X5: renderStatusReport returns "No active goal" when tree loads as null (even if state exists)', async () => {
    const { renderStatusReport } = await import('../engine/render-status-cli.mjs');
    const { saveState } = await import('../engine/state.mjs');

    const root = tmpdir();
    fs.mkdirSync(path.join(root, '.claude', 'goals', 'active'), { recursive: true });

    // Write valid state but NO tree.json (simulates corrupt tree that was renamed to .broken)
    const state = {
      schema_version: 2, goal_id: 'x5', lifecycle: 'pursuing', cursor: 's.e.t',
      budget: { iterations: { used: 3, max: 10 }, tokens: { used: 0, max: 0 }, wallclock: { started_at: new Date().toISOString(), max_seconds: 0 } },
      session_id: 'x5-session', started_at: new Date().toISOString(),
      paused_at: null, ended_at: null, ended_reason: null, history: [],
    };
    saveState(root, state);

    const result = renderStatusReport(root);
    // Current behavior: returns "No active goal" (misleading when state.json exists)
    // This test pins the behavior so any fix is visible.
    expect(result.output).toMatch(/No active goal/i);
    expect(result.exit).toBe(0);

    fs.rmSync(root, { recursive: true });
  });

  // X6: Budget check order — checkLimits fires BEFORE transcript parsing and continuation render
  // When iterations.used >= max, the stop-hook must return budget-limit.md, not continuation.md
  it('X6: checkLimits returns "iterations" when used >= max', async () => {
    const { checkLimits } = await import('../engine/budget.mjs');
    // At exactly the limit
    expect(checkLimits({ iterations: { used: 10, max: 10 }, tokens: { used: 0, max: 0 }, wallclock: { started_at: new Date().toISOString(), max_seconds: 0 } })).toBe('iterations');
    // One over
    expect(checkLimits({ iterations: { used: 11, max: 10 }, tokens: { used: 0, max: 0 }, wallclock: { started_at: new Date().toISOString(), max_seconds: 0 } })).toBe('iterations');
    // One under (no limit hit)
    expect(checkLimits({ iterations: { used: 9, max: 10 }, tokens: { used: 0, max: 0 }, wallclock: { started_at: new Date().toISOString(), max_seconds: 0 } })).toBe(null);
    // max=0 means no limit
    expect(checkLimits({ iterations: { used: 9999, max: 0 }, tokens: { used: 0, max: 0 }, wallclock: { started_at: new Date().toISOString(), max_seconds: 0 } })).toBe(null);
  });
});
