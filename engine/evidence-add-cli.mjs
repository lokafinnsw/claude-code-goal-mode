#!/usr/bin/env node
/**
 * /goal-mode:evidence-add CLI wrapper.
 *
 * Args:
 *   --criterion N           (required, int ≥ 0)
 *   --file path[:line]      (file-based; line optional, parsed from suffix)
 *   --command "cmd"         (shell-based)
 *   --exit-code N           (shell-based)
 *   --note "text"           (optional, default empty)
 *
 * Exactly one of {--file, --command} must be supplied.
 *
 * Exit codes:
 *   0 — evidence added; summary printed to stdout.
 *   1 — precondition failure (no goal, wrong lifecycle, etc.); reason
 *       printed to stderr.
 *   2 — bad CLI argument.
 */
import { evidenceAdd } from './evidence-add.mjs';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--criterion') out.criterion = Number(argv[++i]);
    else if (a === '--file') out.file = argv[++i];
    else if (a === '--line') out.line = Number(argv[++i]);
    else if (a === '--command') out.command = argv[++i];
    else if (a === '--exit-code') out.exit_code = Number(argv[++i]);
    else if (a === '--note') out.note = argv[++i];
    else { console.error(`Unknown arg: ${a}`); process.exit(2); }
  }
  if (!Number.isInteger(out.criterion) || out.criterion < 0) {
    console.error('--criterion <int ≥ 0> required'); process.exit(2);
  }
  const hasFile = typeof out.file === 'string';
  const hasCmd = typeof out.command === 'string';
  if (!hasFile && !hasCmd) {
    console.error('one of --file or --command required'); process.exit(2);
  }
  if (hasFile && out.file.includes(':')) {
    const [f, l] = out.file.split(':');
    out.file = f;
    if (!Number.isNaN(Number(l))) out.line = out.line ?? Number(l);
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const opts = parseArgs(process.argv.slice(2));
  const r = evidenceAdd(process.cwd(), opts);
  if (!r.ok) {
    console.error(`❌ ${r.error}`);
    process.exit(1);
  }
  console.log(`✅ evidence #${r.evidence_count} added to cursor`);
}

export { parseArgs };
