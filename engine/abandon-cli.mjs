#!/usr/bin/env node
/**
 * /goal:abandon CLI wrapper.
 * Args: --reason "..." optional. Unknown args reject (M2/M5 fix).
 */
import { abandonGoal } from './lifecycle-commands.mjs';

const args = process.argv.slice(2);
let reason;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--reason') reason = args[++i];
  else { console.error(`Unknown argument: ${args[i]}\nUsage: /goal-abandon [--reason "..."]`); process.exit(2); }
}
const result = abandonGoal(process.cwd(), { reason });
if (!result.ok) {
  console.error(`❌ ${result.error}`);
  process.exit(1);
}
console.log(`⛔ goal abandoned: ${reason ?? 'manual abandon'}`);
