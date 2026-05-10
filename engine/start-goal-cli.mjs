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
// Real-world finding (May 2026 runtime probe — env | grep CLAUDE inside a
// claude-spawned subprocess of the Mac Desktop app):
//
//   CLAUDE_CODE_ENTRYPOINT=claude-desktop
//   CLAUDE_CODE_EXECPATH=/Users/.../Library/Application Support/Claude/claude-code/<ver>/claude.app/...
//   CLAUDECODE=1
//   CLAUDE_CODE_SESSION_ID: NOT SET
//
// Desktop EMBEDS Claude Code (it's not a separate "SDK subprocess"); the same
// installation drives both the terminal `claude` command and the Desktop app.
// Hooks, settings.json, plugins, slash commands — all shared via ~/.claude/.
//
// Session id propagates as a CLI ARG (`--resume <uuid>`), NOT as an env var,
// in the Desktop-spawned process. So `process.env.CLAUDE_CODE_SESSION_ID` is
// undefined in any subprocess we spawn (slash command !-blocks, Bash tool, etc.)
// even though there IS a session running.
//
// Fallback: store "*" (wildcard) as session_id. The Stop hook treats "*" as
// "match any incoming stdin.session_id" so the continuation loop works wherever
// the env var is unset. CLI users running standalone `claude` get a real env
// var and keep strict session matching.
//
// Trade-off: if you run multiple Claude sessions of the same project
// simultaneously while a goal is active, all of them drive the goal. Acceptable
// for single-user setups, documented in README.
const sessionId = process.env.CLAUDE_CODE_SESSION_ID || '*';
const isWildcard = sessionId === '*';
const result = startGoal(process.cwd(), { sessionId, maxIter, tokenBudget, timeBudgetSeconds, force });
if (!result.ok) { console.error(`❌ ${result.error}`); process.exit(1); }
console.log(`🎯 Goal pursuing — cursor: ${result.cursor}, iter budget: ${maxIter}, token budget: ${tokenBudget}, time budget: ${timeBudgetSeconds}s`);
if (isWildcard) {
  console.log(`(Running in Desktop / no-session mode — all Claude sessions in this project will drive this goal.)`);
}
console.log(`Stop-hook is now active. Make your first move on this task.`);
