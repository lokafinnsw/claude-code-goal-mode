#!/usr/bin/env node
/**
 * /goal-mode:achieve CLI wrapper.
 *
 * Args: none. Operates on the current cursor task in the project rooted at
 * process.cwd(). Validates all acceptance criteria covered, then marks
 * the cursor task achieved (and advances cursor) OR transitions to
 * review-pending if reviewers are required.
 *
 * Exit codes:
 *   0 — achieved or transitioned to review-pending; summary on stdout.
 *   1 — missing-criteria OR other precondition failure; reason on stderr.
 *   2 — bad CLI argument (currently: any argument at all).
 */
import { achieveCursor } from './achieve.mjs';

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  if (args.length > 0) {
    console.error(`Unknown argument(s): ${args.join(' ')}\nUsage: /goal-mode:achieve (no arguments)`);
    process.exit(2);
  }
  const r = achieveCursor(process.cwd());
  if (!r.ok) {
    if (r.missing_criteria) {
      console.error(`❌ missing evidence for criteria: ${r.missing_criteria.join(', ')}`);
      process.exit(1);
    }
    console.error(`❌ ${r.error}`);
    process.exit(1);
  }
  if (r.status === 'achieved') {
    console.log(`✅ achieved → next cursor: ${r.next_cursor}`);
  } else {
    console.log(`🔵 review-pending → reviewers required: ${r.required_reviewers.join(', ')}`);
  }
}
