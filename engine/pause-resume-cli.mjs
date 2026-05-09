#!/usr/bin/env node
/**
 * /goal:pause and /goal:resume CLI wrapper.
 * Single dispatcher; argv[2] is 'pause' | 'resume'.
 */
import { pauseGoal, resumeGoal } from './lifecycle-commands.mjs';

const action = process.argv[2];
if (action !== 'pause' && action !== 'resume') {
  console.error('unknown action; expected pause|resume');
  process.exit(2);
}
const fn = action === 'pause' ? pauseGoal : resumeGoal;
const result = fn(process.cwd());
if (!result.ok) {
  console.error(`❌ ${result.error}`);
  process.exit(1);
}
console.log(action === 'pause' ? '⏸ goal paused' : '▶ goal resumed');
