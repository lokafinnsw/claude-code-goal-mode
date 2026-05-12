#!/usr/bin/env node
/**
 * /goal-mode:submit-verdict CLI wrapper.
 *
 * SECURITY TRUST BOUNDARY: this CLI is the only authorized populator of
 * `scannedAgents` for downstream submitVerdict() calls. It MUST derive
 * the Set from a real transcript scan of Agent() invocations in the
 * current Claude Code session. Do not factor this into a "helper" that
 * callers can mock or override — that would re-open the reviewer-
 * independence bypass vector that the engine layer trusts this code to
 * close.
 *
 * Args:
 *   --agent <subagent_type>   (required)
 *   --status <GO|NOGO|REVISE> (required)
 *   --text "..."              (optional)
 *
 * Exit codes:
 *   0 — verdict accepted; summary on stdout (cursor advanced or status reported).
 *   1 — verdict rejected (independence violation, precondition failure);
 *       reason on stderr.
 *   2 — bad CLI argument.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { submitVerdict } from './submit-verdict.mjs';
import { scanAgentInvocations } from './transcript.mjs';
import { deriveSessionIdFromTranscript } from './start-goal-cli.mjs';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--agent') out.agent = argv[++i];
    else if (a === '--status') out.status = argv[++i];
    else if (a === '--text') out.text = argv[++i];
    else { console.error(`Unknown arg: ${a}`); process.exit(2); }
  }
  if (!out.agent) { console.error('--agent <subagent_type> required'); process.exit(2); }
  if (!out.status) { console.error('--status <GO|NOGO|REVISE> required'); process.exit(2); }
  return out;
}

/**
 * Resolve and scan the current session's transcript for Agent() dispatches.
 * Returns the Set of subagent_types invoked this turn. Empty Set if the
 * transcript can't be located (first-turn / fresh-install / etc.) — the
 * empty Set causes submitVerdict to reject all verdicts unless they
 * match the escape-hatch pattern, which is the correct safe default.
 */
function loadScannedAgents(cwd) {
  const sid = deriveSessionIdFromTranscript(cwd);
  if (!sid) return new Set();
  const encoded = '-' + cwd.replace(/^\//, '').replace(/\//g, '-');
  const tp = path.join(os.homedir(), '.claude', 'projects', encoded, `${sid}.jsonl`);
  if (!fs.existsSync(tp)) return new Set();
  return scanAgentInvocations(tp);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const opts = parseArgs(process.argv.slice(2));
  opts.scannedAgents = loadScannedAgents(process.cwd());
  const r = submitVerdict(process.cwd(), opts);
  if (!r.ok) {
    console.error(`❌ ${r.error}`);
    process.exit(1);
  }
  if (r.next_cursor) {
    console.log(`✅ ${r.status} → next cursor: ${r.next_cursor}`);
  } else {
    console.log(`✅ verdict recorded, cursor status: ${r.status}`);
  }
}

export { parseArgs, loadScannedAgents };
