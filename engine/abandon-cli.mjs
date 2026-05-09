#!/usr/bin/env node
/**
 * /goal:abandon CLI wrapper.
 * Args: --reason "..." optional.
 */
import { abandonGoal } from './lifecycle-commands.mjs';

const reasonIdx = process.argv.indexOf('--reason');
const reason = reasonIdx === -1 ? undefined : process.argv[reasonIdx + 1];
const result = abandonGoal(process.cwd(), { reason });
if (!result.ok) {
  console.error(`❌ ${result.error}`);
  process.exit(1);
}
console.log(`⛔ goal abandoned: ${reason ?? 'manual abandon'}`);
