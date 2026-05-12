#!/usr/bin/env node
/**
 * /goal-mode:goal-extend CLI wrapper.
 *
 * Args:
 *   --tokens VALUE   (e.g. +50M, 150M, +50000000, 60000000)
 *   --iter VALUE     (e.g. +1000, 5000)
 *   --time VALUE     (e.g. +4h, 8h, +30m, +2d, +3600, 3600)
 *
 * Value prefix:
 *   '+' → delta-add to current max
 *   bare → absolute-set max
 *
 * Suffixes:
 *   tokens: k=1000, m=1000000 (case-insensitive)
 *   time:   s=seconds, m=minutes, h=hours, d=days (case-insensitive)
 *   iter:   bare integer only
 *
 * Exit codes:
 *   0 — bumped; summary on stdout.
 *   1 — precondition failure (no goal, wrong lifecycle, new max < used).
 *   2 — bad CLI argument.
 */
import { extendBudget } from './goal-extend.mjs';

function parseTokens(s) {
  const m = String(s).match(/^([+]?)(\d+)([km]?)$/i);
  if (!m) throw new Error(`bad --tokens value: ${s}`);
  const mode = m[1] === '+' ? 'delta' : 'absolute';
  const n = parseInt(m[2], 10);
  const suffix = m[3].toLowerCase();
  const mult = suffix === 'k' ? 1000 : suffix === 'm' ? 1000000 : 1;
  return { mode, value: n * mult };
}

function parseIter(s) {
  const m = String(s).match(/^([+]?)(\d+)$/);
  if (!m) throw new Error(`bad --iter value: ${s}`);
  return { mode: m[1] === '+' ? 'delta' : 'absolute', value: parseInt(m[2], 10) };
}

function parseTime(s) {
  // Allow '+8h', '4h', '+30m', '2d', '+3600s', '+3600' (bare seconds).
  const m = String(s).match(/^([+]?)(\d+)([smhd]?)$/i);
  if (!m) throw new Error(`bad --time value: ${s}`);
  const mode = m[1] === '+' ? 'delta' : 'absolute';
  const n = parseInt(m[2], 10);
  const unit = m[3].toLowerCase();
  const seconds = unit === 'h' ? n * 3600
    : unit === 'm' ? n * 60
    : unit === 'd' ? n * 86400
    : n; // 's' or no suffix → seconds
  return { mode, value: seconds };
}

function fmtTokens(n) {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(0)}k`;
  return String(n);
}

function fmtTime(seconds) {
  if (seconds >= 86400) return `${(seconds / 86400).toFixed(1)}d`;
  if (seconds >= 3600) return `${(seconds / 3600).toFixed(1)}h`;
  if (seconds >= 60) return `${(seconds / 60).toFixed(0)}m`;
  return `${seconds}s`;
}

const USAGE =
  'Usage: /goal-mode:goal-extend [--tokens +N|N[km]] [--iter +N|N] [--time +Nh|Nh|Nm|Nd|Ns]';

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--tokens') opts.tokens = parseTokens(argv[++i]);
    else if (a === '--iter') opts.iter = parseIter(argv[++i]);
    else if (a === '--time') opts.time = parseTime(argv[++i]);
    else throw new Error(`Unknown arg: ${a}`);
  }
  return opts;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`❌ ${err.message}\n${USAGE}`);
    process.exit(2);
  }
  const r = extendBudget(process.cwd(), opts);
  if (!r.ok) {
    console.error(`❌ ${r.error}`);
    process.exit(1);
  }
  console.log(`✅ budget extended:`);
  if (r.new.tokens !== r.old.tokens) {
    console.log(`  tokens: ${fmtTokens(r.old.tokens)} → ${fmtTokens(r.new.tokens)}`);
  }
  if (r.new.iter !== r.old.iter) {
    console.log(`  iter:   ${r.old.iter} → ${r.new.iter}`);
  }
  if (r.new.time_seconds !== r.old.time_seconds) {
    console.log(`  time:   ${fmtTime(r.old.time_seconds)} → ${fmtTime(r.new.time_seconds)}`);
  }
  if (r.lifecycle_transition) {
    console.log(`  lifecycle: ${r.lifecycle_transition.from} → ${r.lifecycle_transition.to}`);
  }
}

export { parseTokens, parseIter, parseTime, parseArgs, fmtTokens, fmtTime };
