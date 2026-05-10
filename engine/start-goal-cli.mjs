#!/usr/bin/env node
/**
 * /goal:start CLI wrapper.
 *
 * Parses --max-iter / --token-budget / --time-budget args. Resolves the
 * Claude Code session UUID via:
 *   1. CLAUDE_CODE_SESSION_ID env var (set in standalone CLI), OR
 *   2. The basename of the most-recent .jsonl in
 *      ~/.claude/projects/<encoded-cwd>/ (Desktop and CLI both write here).
 * Dispatches to startGoal(cwd, ...).
 *
 * Exit codes:
 *   0 — goal started; cursor + budget summary printed to stdout.
 *   1 — precondition failure (no tree, not approved, no pending tasks);
 *       reason printed to stderr.
 *   2 — bad CLI argument or session id unresolvable.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startGoal } from './start-goal.mjs';

function parsePositiveInt(label, raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
    console.error(`bad --${label}: ${raw}`);
    process.exit(2);
  }
  return n;
}

/**
 * Encode an absolute cwd into the format Claude Code uses for transcript dirs:
 *   /Users/foo/bar  →  -Users-foo-bar
 * Both standalone CLI and Desktop write transcripts to
 * ~/.claude/projects/<encoded>/<session-uuid>.jsonl. The basename (sans
 * extension) of the most-recently-modified file in that dir IS the active
 * session UUID — same value Stop-hook stdin will deliver as `session_id`.
 *
 * Returns null if dir or transcript missing (very-first-turn case before
 * any user message has been flushed).
 */
export function deriveSessionIdFromTranscript(cwd) {
  const encoded = '-' + cwd.replace(/^\//, '').replace(/\//g, '-');
  const dir = path.join(os.homedir(), '.claude', 'projects', encoded);
  try {
    const entries = fs.readdirSync(dir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => ({ name: f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    if (entries.length === 0) return null;
    return entries[0].name.replace(/\.jsonl$/, '');
  } catch {
    return null;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
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

  // Source 1: env var (set by standalone CLI at session start; NOT set in
  // Desktop's embedded Claude Code subprocess where the session id propagates
  // as a `--resume <uuid>` CLI arg instead).
  let sessionId = process.env.CLAUDE_CODE_SESSION_ID;
  let sessionSource = sessionId ? 'env' : null;

  // Source 2: derive from transcript dir. Both CLI and Desktop write
  // ~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl on every turn,
  // so the most-recent .jsonl basename IS the live session id. This is the
  // SAME id Stop-hook stdin will deliver — strict session_id matching in
  // stop-hook.mjs continues to work without any wildcard escape hatch.
  if (!sessionId) {
    sessionId = deriveSessionIdFromTranscript(process.cwd());
    sessionSource = 'transcript';
  }

  if (!sessionId) {
    const encoded = '-' + process.cwd().replace(/^\//, '').replace(/\//g, '-');
    console.error('Cannot resolve Claude Code session id.');
    console.error('Tried 1) CLAUDE_CODE_SESSION_ID env var (unset).');
    console.error(`Tried 2) most-recent .jsonl in ~/.claude/projects/${encoded}/ (no transcripts found).`);
    console.error('If this is a fresh session, send any message first so a transcript file exists, then retry /goal-start.');
    process.exit(2);
  }

  const result = startGoal(process.cwd(), { sessionId, maxIter, tokenBudget, timeBudgetSeconds, force });
  if (!result.ok) { console.error(`❌ ${result.error}`); process.exit(1); }
  console.log(`🎯 Goal pursuing — cursor: ${result.cursor}, iter budget: ${maxIter}, token budget: ${tokenBudget}, time budget: ${timeBudgetSeconds}s`);
  console.log(`(session id resolved from ${sessionSource}: ${sessionId})`);
  console.log(`Stop-hook is now active. Make your first move on this task.`);
}
