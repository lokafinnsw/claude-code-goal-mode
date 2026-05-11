#!/usr/bin/env node
/**
 * SessionStart hook CLI wrapper.
 * Reads JSON stdin (CC's SessionStart payload) and routes to runSessionStartHook.
 */
import { runSessionStartHook } from './session-start-hook.mjs';

let raw = '';
for await (const chunk of process.stdin) raw += chunk;
let stdin = {};
try {
  stdin = raw.trim() ? JSON.parse(raw) : {};
} catch (_) {
  stdin = {};
}

const result = await runSessionStartHook({ stdin, projectRoot: process.cwd() });
if (result.stdout) process.stdout.write(JSON.stringify(result.stdout));
process.exit(result.exit);
