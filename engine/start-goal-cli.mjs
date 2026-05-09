#!/usr/bin/env node
/**
 * /goal:start CLI wrapper.
 *
 * Parses --max-iter / --token-budget / --time-budget args, reads
 * CLAUDE_CODE_SESSION_ID from env, dispatches to startGoal(cwd, ...).
 *
 * Exit codes:
 *   0 — goal started; cursor + budget summary printed to stdout.
 *   1 — precondition failure (no tree, not approved, no pending tasks);
 *       reason printed to stderr.
 *   2 — bad CLI argument (e.g., malformed --time-budget).
 */
import { startGoal } from './start-goal.mjs';

const args = process.argv.slice(2);
let maxIter = 100, tokenBudget = 2_000_000, timeBudgetSeconds = 14400;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--max-iter') maxIter = Number(args[++i]);
  else if (args[i] === '--token-budget') tokenBudget = Number(args[++i]);
  else if (args[i] === '--time-budget') {
    const v = args[++i];
    const m = v.match(/^(\d+)([mh])?$/);
    if (!m) { console.error(`bad --time-budget: ${v}`); process.exit(2); }
    const n = Number(m[1]);
    timeBudgetSeconds = m[2] === 'h' ? n * 3600 : n * 60;
  }
}
const sessionId = process.env.CLAUDE_CODE_SESSION_ID ?? 'unknown';
const result = startGoal(process.cwd(), { sessionId, maxIter, tokenBudget, timeBudgetSeconds });
if (!result.ok) { console.error(`❌ ${result.error}`); process.exit(1); }
console.log(`🎯 Goal pursuing — cursor: ${result.cursor}, iter budget: ${maxIter}, token budget: ${tokenBudget}, time budget: ${timeBudgetSeconds}s`);
console.log(`Stop-hook is now active. Make your first move on this task.`);
