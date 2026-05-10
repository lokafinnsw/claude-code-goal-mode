#!/usr/bin/env node
/**
 * /goal:approve CLI wrapper.
 * Args: --reason "..." optional.
 * Thin shell over manualApprove(). CLI body guarded by import.meta.url ===
 * check so tests can import the module without triggering side effects.
 */
import { manualApprove } from './manual-approve.mjs';

if (import.meta.url === `file://${process.argv[1]}`) {
  const reasonIdx = process.argv.indexOf('--reason');
  const reason = reasonIdx === -1 ? undefined : process.argv[reasonIdx + 1];
  const result = manualApprove(process.cwd(), reason ? { reason } : {});
  if (!result.ok) {
    console.error(`❌ ${result.error}`);
    process.exit(1);
  }
  console.log(`✅ manually approved → cursor: ${result.cursor}`);
}
