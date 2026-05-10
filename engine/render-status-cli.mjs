#!/usr/bin/env node
/**
 * /goal:status CLI wrapper.
 *
 * Function: renderStatusReport(projectRoot): { output, exit }
 *
 * Behavior:
 *   - If both tree.json and state.json load: return rendered status.
 *   - If neither loads (no active goal):
 *     - Scan archive dir for archived runs.
 *     - If archives exist: return "No active goal. (N archived goals
 *       at .claude/goals/archive/ — pick one to inspect.)"
 *     - If no archives: return "No active goal. Run /goal:plan to start."
 *   - Always exit 0 (status display is informational, never errors).
 *
 * The CLI body is guarded by `import.meta.url ===` so tests can import
 * `renderStatusReport` without triggering side effects.
 */

import fs from 'node:fs';
import path from 'node:path';
import { loadTree, loadState } from './state.mjs';
import { renderStatus } from './render-status.mjs';
import { archiveDir } from './paths.mjs';

export function renderStatusReport(projectRoot) {
  const tree = loadTree(projectRoot);
  const state = loadState(projectRoot);
  if (tree && state) {
    return { output: renderStatus(tree, state), exit: 0 };
  }
  const archives = countArchives(projectRoot);
  if (archives > 0) {
    return {
      output: `No active goal. (${archives} archived goal${archives === 1 ? '' : 's'} at ${archiveDir(projectRoot)} — pick one to inspect.)`,
      exit: 0,
    };
  }
  return {
    output: 'No active goal. Run /goal:plan to start.',
    exit: 0,
  };
}

function countArchives(projectRoot) {
  const dir = archiveDir(projectRoot);
  if (!fs.existsSync(dir)) return 0;
  try {
    return fs.readdirSync(dir).filter(name => {
      const full = path.join(dir, name);
      try {
        return fs.statSync(full).isDirectory();
      } catch {
        return false;
      }
    }).length;
  } catch {
    return 0;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = renderStatusReport(process.cwd());
  console.log(result.output);
  process.exit(result.exit);
}
