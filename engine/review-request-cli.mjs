#!/usr/bin/env node
/**
 * /goal-mode:review-request CLI wrapper.
 *
 * Read-only. Prints the reviewer list + audit-instructions template
 * for the cursor task (which must be in review-pending status).
 *
 * Modes:
 *   (default) — human-readable formatted output
 *   --json    — full result as JSON
 *
 * Exit codes:
 *   0 — printed successfully.
 *   1 — precondition failure.
 *   2 — bad arg.
 */
import { reviewRequest, formatReviewRequest } from './review-request.mjs';

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const unknown = args.find(a => a !== '--json');
  if (unknown) {
    console.error(`Unknown arg: ${unknown}\nUsage: /goal-mode:review-request [--json]`);
    process.exit(2);
  }
  const r = reviewRequest(process.cwd());
  if (!r.ok) {
    console.error(`❌ ${r.error}`);
    process.exit(1);
  }
  if (json) console.log(JSON.stringify(r, null, 2));
  else console.log(formatReviewRequest(r));
}
