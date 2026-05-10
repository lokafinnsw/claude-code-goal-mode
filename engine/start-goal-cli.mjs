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

function parsePositiveInt(label, raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
    console.error(`bad --${label}: ${raw}`);
    process.exit(2);
  }
  return n;
}

const args = process.argv.slice(2);
let maxIter = 100, tokenBudget = 2_000_000, timeBudgetSeconds = 14400;
let force = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--max-iter') maxIter = parsePositiveInt('max-iter', args[++i]);
  else if (args[i] === '--token-budget') tokenBudget = parsePositiveInt('token-budget', args[++i]);
  else if (args[i] === '--time-budget') {
    const v = args[++i];
    const m = v.match(/^(\d+)([mh])?$/);
    if (!m) { console.error(`bad --time-budget: ${v}`); process.exit(2); }
    const n = Number(m[1]);
    timeBudgetSeconds = m[2] === 'h' ? n * 3600 : n * 60;
  }
  else if (args[i] === '--force') force = true;
  else {
    console.error(`Unknown argument: ${args[i]}\nUsage: /goal-start [--max-iter N] [--token-budget N] [--time-budget Nm|Nh] [--force]`);
    process.exit(2);
  }
}
// CLAUDE_CODE_SESSION_ID is set ONLY in interactive Claude Code CLI mode.
// Claude Desktop spawns Claude Code as SDK subprocess (CLAUDE_CODE_ENTRYPOINT=sdk-ts)
// without setting this var. Reverse-engineering the CC binary confirms:
//   if(process.env.CLAUDE_CODE_SESSION_ID) process.env.CLAUDE_CODE_SESSION_ID = Z_();
// — conditional, only re-set if already set. So Desktop = no env var, ever.
//
// Fallback: store "*" (wildcard) as session_id. The Stop hook treats "*" as
// "match any incoming stdin.session_id" so the continuation loop works in both
// Desktop and CLI. Trade-off: if user runs multiple Claude Code sessions of the
// same project simultaneously while a goal is active, all of them will drive
// the goal. CLI users with a real session_id keep strict matching.
const sessionId = process.env.CLAUDE_CODE_SESSION_ID || '*';
const isWildcard = sessionId === '*';
const result = startGoal(process.cwd(), { sessionId, maxIter, tokenBudget, timeBudgetSeconds, force });
if (!result.ok) { console.error(`❌ ${result.error}`); process.exit(1); }
console.log(`🎯 Goal pursuing — cursor: ${result.cursor}, iter budget: ${maxIter}, token budget: ${tokenBudget}, time budget: ${timeBudgetSeconds}s`);
if (isWildcard) {
  console.log(`(Running in Desktop / no-session mode — all Claude sessions in this project will drive this goal.)`);
}
console.log(`Stop-hook is now active. Make your first move on this task.`);
