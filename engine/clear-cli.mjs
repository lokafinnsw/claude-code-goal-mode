#!/usr/bin/env node
/**
 * /goal:clear CLI wrapper.
 * Args: --archive optional flag. Unknown args reject (M2/M5 fix).
 */
import { clearGoal } from './lifecycle-commands.mjs';

const args = process.argv.slice(2);
let archive = false;
for (const a of args) {
  if (a === '--archive') archive = true;
  else { console.error(`Unknown argument: ${a}\nUsage: /goal-clear [--archive]`); process.exit(2); }
}
const result = clearGoal(process.cwd(), { archive });
if (!result.ok) {
  console.error(`❌ ${result.error}`);
  process.exit(1);
}
if (result.noop) {
  console.log('No active goal.');
  process.exit(0);
}
if (result.archivedTo) {
  console.log(`📦 archived to ${result.archivedTo}`);
}
console.log('🧹 active goal cleared');
