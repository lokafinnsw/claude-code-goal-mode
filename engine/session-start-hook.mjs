/**
 * SessionStart hook orchestrator.
 *
 * Fires when CC opens a new session in a project. If an active pursuing goal
 * exists, emit the same continuation prompt the Stop hook would so the user
 * doesn't have to type "продолжай" / "/goal-status" to re-engage. Paused /
 * achieved / unmet / no-goal cases are passthroughs (null stdout).
 *
 * Like stop-hook, this swallows internal errors into a visible block-decision
 * diagnostic so silent stalls are impossible. See engine/stop-hook.mjs for
 * the same error-as-prompt contract.
 */

import path from 'node:path';
import { loadState, loadTree } from './state.mjs';
import { findNodeById } from './traversal.mjs';
import { buildContext, render } from './continuation.mjs';
import fs from 'node:fs';

function readPrompt(name, pluginRoot) {
  return fs.readFileSync(path.join(pluginRoot, 'prompts', name), 'utf8');
}

export async function runSessionStartHook({ stdin, projectRoot }) {
  try {
    const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT
      ?? path.resolve(new URL('..', import.meta.url).pathname);

    const state = loadState(projectRoot);
    if (!state) return { exit: 0, stdout: null };
    if (state.lifecycle !== 'pursuing') return { exit: 0, stdout: null };

    const tree = loadTree(projectRoot);
    if (!tree) return { exit: 0, stdout: null };

    const cursor = findNodeById(tree, state.cursor);
    if (!cursor) {
      return {
        exit: 0,
        stdout: {
          hookSpecificOutput: {
            hookEventName: 'SessionStart',
            additionalContext: `⚠️ goal-mode SessionStart: cursor "${state.cursor}" does not resolve in tree. Run /goal-mode:goal-doctor for diagnostics.`,
          },
        },
      };
    }

    let templateName = 'continuation.md';
    if (cursor.status === 'review-pending') templateName = 'continuation-review.md';
    else if (cursor.status === 'blocked') templateName = 'continuation-blocked.md';

    const ctx = buildContext(tree, state, state.cursor);
    if (!ctx) return { exit: 0, stdout: null };

    const rendered = render(readPrompt(templateName, PLUGIN_ROOT), ctx);

    // SessionStart hook payload: additionalContext is injected before the
    // user's first message of the new session.
    return {
      exit: 0,
      stdout: {
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext: `🎯 goal-mode auto-resume — active goal "${state.goal_id}" at cursor ${state.cursor}.\n\n${rendered}`,
        },
      },
    };
  } catch (err) {
    const errMsg = String(err?.message ?? err);
    console.error(`[goal-mode] runSessionStartHook caught error: ${errMsg}`, err?.stack);
    return {
      exit: 0,
      stdout: {
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext: `⚠️ goal-mode SessionStart engine error: ${errMsg}\n\nRun /goal-mode:goal-doctor for diagnostics.`,
        },
      },
      error: errMsg,
    };
  }
}
