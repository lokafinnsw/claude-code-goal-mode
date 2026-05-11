/**
 * Reducer purity lint — acceptance gate G1.6 (ADR-0001 §Reducer invariants).
 *
 * Invariant: `engine/reducer.mjs` must be a **pure function**:
 *   - No `Date.now()` or `new Date()` without ts-from-event
 *   - No `Math.random()`
 *   - No `fs.*` (no I/O)
 *   - No `process.env` (no environment-dependent behavior)
 *   - No `import 'node:fs'`, `node:child_process`, `node:http*`, etc.
 *
 * This test enforces by reading the reducer source and grep-checking. A
 * proper ESLint plugin would be cleaner but adds setup cost. Source-grep
 * is sufficient for a single-file invariant we want to lock down.
 *
 * If you legitimately need a clock or random source in the reducer (e.g.,
 * to attach a `recorded_at` timestamp), pass it as an argument from the
 * caller — never reach into globals.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const REDUCER_PATH = path.resolve(
  new URL('..', import.meta.url).pathname,
  'engine',
  'reducer.mjs',
);

const FORBIDDEN_PATTERNS = [
  // Clock access
  { re: /\bDate\.now\b/, name: 'Date.now()', why: 'reducer must not depend on wall-clock time; use event.ts instead' },
  { re: /\bnew\s+Date\s*\(\s*\)/, name: 'new Date()', why: 'reducer must not generate new wall-clock timestamps; use event.ts instead' },
  // Random
  { re: /\bMath\.random\b/, name: 'Math.random()', why: 'reducer must be deterministic; no random sources allowed' },
  { re: /\bcrypto\.randomUUID\b/, name: 'crypto.randomUUID()', why: 'reducer must be deterministic; event ids are assigned by event-log writer' },
  // I/O
  { re: /from\s+['"]node:fs['"]/, name: "import from 'node:fs'", why: 'reducer must not perform I/O; events come from caller' },
  { re: /from\s+['"]node:fs\/promises['"]/, name: "import from 'node:fs/promises'", why: 'reducer must not perform I/O' },
  { re: /from\s+['"]node:child_process['"]/, name: "import from 'node:child_process'", why: 'reducer must not spawn subprocesses' },
  { re: /from\s+['"]node:http['"]|from\s+['"]node:https['"]|from\s+['"]node:net['"]/, name: 'network imports', why: 'reducer must not perform network I/O' },
  // Environment
  { re: /\bprocess\.env\b/, name: 'process.env', why: 'reducer must not branch on environment variables' },
  { re: /\bprocess\.argv\b/, name: 'process.argv', why: 'reducer must not read process args' },
  // Mutation of global state
  { re: /\bprocess\.stdout\.write/, name: 'process.stdout.write', why: 'reducer must not write to stdout (consumes side-channel)' },
  { re: /\bprocess\.stderr\.write/, name: 'process.stderr.write', why: 'reducer must not write to stderr' },
  { re: /\bconsole\.(log|warn|error|info|debug)/, name: 'console.*', why: 'reducer must not log (consumes side-channel)' },
];

describe('G1.6 acceptance gate — reducer.mjs is pure', () => {
  let source;
  it('reducer.mjs source loads', () => {
    source = fs.readFileSync(REDUCER_PATH, 'utf8');
    expect(source.length).toBeGreaterThan(100);
  });

  for (const { re, name, why } of FORBIDDEN_PATTERNS) {
    it(`reducer.mjs must NOT use ${name} — ${why}`, () => {
      if (!source) source = fs.readFileSync(REDUCER_PATH, 'utf8');
      // Strip comments before grep so docstrings can mention forbidden APIs
      // without tripping the lint.
      const codeOnly = source
        .replace(/\/\*[\s\S]*?\*\//g, '')  // block comments
        .replace(/\/\/[^\n]*/g, '');         // line comments
      const match = codeOnly.match(re);
      if (match) {
        const linesBefore = codeOnly.slice(0, match.index).split('\n').length;
        throw new Error(
          `Forbidden pattern "${name}" found at line ~${linesBefore} of reducer.mjs.\nReason: ${why}\nMatch: "${match[0]}"`,
        );
      }
      expect(match).toBeNull();
    });
  }

  it('reducer.mjs imports only from traversal.mjs (and no I/O-capable modules)', () => {
    if (!source) source = fs.readFileSync(REDUCER_PATH, 'utf8');
    const importLines = source.split('\n').filter((l) => /^import\b/.test(l.trim()));
    const ALLOWED_IMPORTS = ['./traversal.mjs'];
    for (const line of importLines) {
      const match = line.match(/from\s+['"]([^'"]+)['"]/);
      if (!match) continue;
      const spec = match[1];
      expect(
        ALLOWED_IMPORTS.includes(spec),
        `Reducer must not import "${spec}" — only ${ALLOWED_IMPORTS.join(', ')} allowed (no I/O, no system access).`,
      ).toBe(true);
    }
  });

  it('reducer.mjs exports the `reduce` function', () => {
    if (!source) source = fs.readFileSync(REDUCER_PATH, 'utf8');
    expect(source).toMatch(/export\s+function\s+reduce\b/);
  });
});
