#!/usr/bin/env node
/**
 * /goal-mode:goal-doctor CLI — renders the DoctorReport for terminal output.
 *
 * Flags:
 *   --fix    Apply safe auto-fixes (delete .broken-*, trim pre-migration
 *            backups to 3 newest). Re-runs the report afterwards.
 *   --json   Emit the report as JSON instead of human-readable text.
 *
 * Glyph convention (human mode):
 *   ✓ ok    ⚠ warn    ✗ fail
 *
 * Exit code = report.exitCode (1 if any check fails, 0 otherwise).
 */

import { runDoctor, runFix } from './doctor.mjs';

const GLYPH = { ok: '✓', warn: '⚠', fail: '✗' };

function renderHuman(report) {
  const lines = [];
  lines.push('goal-mode doctor');
  lines.push('────────────────');
  for (const c of report.checks) {
    lines.push(`${GLYPH[c.status]} ${c.id} — ${c.message}`);
    if (c.fix) lines.push(`  → fix: ${c.fix}`);
  }
  lines.push('');
  lines.push(
    `summary: ${report.summary.ok} ok, ${report.summary.warn} warn, ${report.summary.fail} fail (exit ${report.exitCode})`,
  );
  return lines.join('\n');
}

const args = new Set(process.argv.slice(2));
const wantFix = args.has('--fix');
const wantJson = args.has('--json');

const projectRoot = process.cwd();

if (wantFix) {
  const applied = runFix(projectRoot);
  if (!wantJson) {
    process.stdout.write('goal-mode doctor --fix\n');
    process.stdout.write('──────────────────────\n');
    for (const a of applied) {
      const glyph = a.ran ? '✓' : '·';
      process.stdout.write(`${glyph} ${a.id}: ${a.message}\n`);
    }
    process.stdout.write('\n');
  }
}

const report = runDoctor(projectRoot);

if (wantJson) {
  const out = wantFix
    ? { fix_applied: runFix(projectRoot), ...report }
    : report;
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
} else {
  process.stdout.write(renderHuman(report) + '\n');
}

process.exit(report.exitCode);
