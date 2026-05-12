#!/usr/bin/env node
/**
 * /goal-mode:current CLI wrapper.
 *
 * Read-only inspector of the cursor task. Three output modes:
 *   --json         JSON dump of the full result object
 *   --as-builtin   single-line text for piping into built-in /goal "..."
 *   (default)      human-readable multiline summary
 *
 * Exit codes:
 *   0 — printed result.
 *   1 — no active goal / tree / cursor (error to stderr).
 *   2 — unknown flag.
 */
import { currentTask, formatHuman, formatAsBuiltin } from './current.mjs';

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const asBuiltin = args.includes('--as-builtin');
  const unknown = args.find(a => a !== '--json' && a !== '--as-builtin');
  if (unknown) {
    console.error(`Unknown arg: ${unknown}\nUsage: /goal-mode:current [--json|--as-builtin]`);
    process.exit(2);
  }
  if (json && asBuiltin) {
    console.error('--json and --as-builtin are mutually exclusive');
    process.exit(2);
  }
  const r = currentTask(process.cwd());
  if (!r.ok) {
    console.error(`❌ ${r.error}`);
    process.exit(1);
  }
  if (json) console.log(JSON.stringify(r, null, 2));
  else if (asBuiltin) console.log(formatAsBuiltin(r));
  else console.log(formatHuman(r));
}
