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
import { archiveDir, activeDir, treePath, statePath } from './paths.mjs';

export function renderStatusReport(projectRoot) {
  const tree = loadTree(projectRoot);
  const state = loadState(projectRoot);
  if (tree && state) {
    return { output: renderStatus(tree, state), exit: 0 };
  }
  // Partial-corruption branch: if EITHER file exists on disk but failed to load
  // (loadTree/loadState renamed it to .broken-<ts>-<seq> via readWithBackup),
  // do NOT report "no active goal". That message tempts the user to run
  // /goal-plan, which OVERWRITES state.json and destroys whatever survived.
  const treeBroken = !tree && fileExists(treePath(projectRoot));
  const stateBroken = !state && fileExists(statePath(projectRoot));
  const treeBackups = listBackups(projectRoot, 'tree.json.broken-');
  const stateBackups = listBackups(projectRoot, 'state.json.broken-');
  if (treeBroken || stateBroken || treeBackups.length || stateBackups.length) {
    const lines = ['⚠️  Goal directory has corrupt state. NOT running plan/start would destroy data.'];
    if (treeBroken) lines.push(`  - tree.json present but unparseable; just renamed to .broken-* during this status read.`);
    if (stateBroken) lines.push(`  - state.json present but unparseable; just renamed to .broken-* during this status read.`);
    if (treeBackups.length) {
      lines.push(`  - tree.json forensic copies (${treeBackups.length}):`);
      for (const f of treeBackups.slice(0, 3)) lines.push(`      ${f}`);
      if (treeBackups.length > 3) lines.push(`      ... and ${treeBackups.length - 3} more`);
    }
    if (stateBackups.length) {
      lines.push(`  - state.json forensic copies (${stateBackups.length}):`);
      for (const f of stateBackups.slice(0, 3)) lines.push(`      ${f}`);
      if (stateBackups.length > 3) lines.push(`      ... and ${stateBackups.length - 3} more`);
    }
    if (state) {
      lines.push('');
      lines.push(`State preserved (lifecycle="${state.lifecycle}", goal_id="${state.goal_id}"). To recover:`);
      lines.push(`  1. Inspect a .broken-* copy from ${activeDir(projectRoot)} to see what failed.`);
      lines.push(`  2. Restore tree.json from the copy or from version control.`);
      lines.push(`  3. Re-run /goal-status to verify.`);
      lines.push('Do NOT run /goal-plan or /goal-start until tree.json is restored.');
    } else if (tree) {
      lines.push('');
      lines.push('Tree preserved. State must be reconstructed manually or restored from version control.');
      lines.push('Do NOT run /goal-plan or /goal-start until state.json is restored.');
    } else {
      lines.push('');
      lines.push('Both files unparseable. Inspect .broken-* copies for the source of corruption.');
      lines.push('Once you understand the cause, /goal-clear --archive can move the active dir to archive,');
      lines.push('then /goal-plan or /goal-plan-from-file can start fresh.');
    }
    return { output: lines.join('\n'), exit: 0 };
  }
  const archives = countArchives(projectRoot);
  if (archives > 0) {
    return {
      output: `No active goal. (${archives} archived goal${archives === 1 ? '' : 's'} at ${archiveDir(projectRoot)} — pick one to inspect.)`,
      exit: 0,
    };
  }
  return {
    output: 'No active goal. Run /goal-plan to start.',
    exit: 0,
  };
}

function fileExists(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

function listBackups(projectRoot, prefix) {
  const dir = activeDir(projectRoot);
  if (!fs.existsSync(dir)) return [];
  try {
    return fs.readdirSync(dir)
      .filter(name => name.startsWith(prefix))
      .sort()
      .reverse()
      .map(name => path.join(dir, name));
  } catch {
    return [];
  }
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
