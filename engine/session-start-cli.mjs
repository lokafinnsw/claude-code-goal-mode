#!/usr/bin/env node
/**
 * SessionStart hook CLI wrapper.
 * Reads JSON stdin (CC's SessionStart payload) and routes to runSessionStartHook.
 *
 * projectRoot is resolved via `resolveProjectRoot(stdin)` — prefers
 * `stdin.cwd` over `process.cwd()`. See `engine/project-root.mjs` for the
 * full rationale (cross-project leakage bug fix landed in v2.0.2).
 */
import fs from 'node:fs';
import path from 'node:path';
import { runSessionStartHook } from './session-start-hook.mjs';
import { resolveProjectRoot } from './project-root.mjs';

let raw = '';
for await (const chunk of process.stdin) raw += chunk;
let stdin = {};
try {
  stdin = raw.trim() ? JSON.parse(raw) : {};
} catch (_) {
  stdin = {};
}

const projectRoot = resolveProjectRoot(stdin, { fs, path, fallbackCwd: process.cwd() });
const result = await runSessionStartHook({ stdin, projectRoot });
if (result.stdout) process.stdout.write(JSON.stringify(result.stdout));
process.exit(result.exit);
