/**
 * SessionStart hook orchestrator.
 *
 * Fires when CC opens a new session in a project. If an active pursuing goal
 * exists, emit the same continuation prompt the Stop hook would so the user
 * doesn't have to type "продолжай" / "/goal-status" to re-engage. Paused /
 * achieved / unmet / no-goal cases are passthroughs (null stdout).
 *
 * v2.0.3: enrichment context for review-pending / blocked templates now
 * uses the same shared `enrichContinuationContext` helper as the Stop hook
 * (bug C1 fix). Previously SessionStart called `buildContext` and rendered
 * directly, leaving `{{audit_instructions}}`, `{{rejected_verdicts}}`,
 * `{{unavailable_reviewers_csv}}` etc. as undefined / literal placeholders
 * in the rendered prompt when the cursor was in review-pending or blocked
 * state at session start time.
 *
 * Like stop-hook, this swallows internal errors into a visible block-decision
 * diagnostic so silent stalls are impossible. See engine/stop-hook.mjs for
 * the same error-as-prompt contract.
 */

import { loadState, loadTree } from './state.mjs';
import { findNodeById } from './traversal.mjs';
import { buildContext, render } from './continuation.mjs';
import {
  enrichContinuationContext,
  hasActiveGoal,
  readPromptFile,
  resolvePluginRoot,
} from './hook-context.mjs';

export async function runSessionStartHook({ stdin, projectRoot }) {
  try {
    // Fast precheck (bug C2 fix): if no active goal in this project, return
    // immediately. SessionStart doesn't acquire a lock (read-only path) so
    // the directory-pollution concern is lower than for Stop hook, but the
    // check still saves a stat + parse cycle per session.
    if (!hasActiveGoal(projectRoot)) return { exit: 0, stdout: null };

    const PLUGIN_ROOT = resolvePluginRoot(import.meta.url);

    const state = loadState(projectRoot);
    if (!state) return { exit: 0, stdout: null };
    // v2.0.4: surface awaiting-manual-approval lifecycle on SessionStart so
    // the user sees the stalled state when they open a new session. Without
    // this, the session is silent (lifecycle !== 'pursuing' gate suppresses
    // everything) and the user has no idea why the goal isn't advancing.
    if (state.lifecycle === 'awaiting-manual-approval') {
      return {
        exit: 0,
        stdout: {
          hookSpecificOutput: {
            hookEventName: 'SessionStart',
            additionalContext:
              `⛔ goal-mode: active goal "${state.goal_id}" is waiting for manual approval on cursor ${state.cursor}.\n\n`
              + `A reviewer subagent_type was unavailable in this environment when the gate fired. The goal is paused (no Stop-hook prompts will fire) until you do ONE of:\n`
              + `  • Override: run \`/goal-mode:goal-approve ${state.cursor}\` to GO the blocked node and resume work\n`
              + `  • Register reviewer: create ~/.claude/agents/<name>.md with matching \`name:\` frontmatter, then \`/goal-mode:goal-abandon\` + replan if you want a fresh review\n`
              + `  • Abandon: \`/goal-mode:goal-abandon\` if you no longer want this goal\n\n`
              + `Run \`/goal-mode:goal-doctor\` for full diagnostics.`,
          },
        },
      };
    }
    // v3.0.7: auto-paused-on-silence recovery branch removed (feature
    // removed entirely). User-initiated /goal-pause falls through to the
    // null-stdout passthrough (user knows they paused it).
    if (state.lifecycle === 'paused') {
      return { exit: 0, stdout: null };
    }
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

    // Bug C1 fix: same enrichment pipeline as Stop hook. Without this,
    // review-pending / blocked auto-resume rendered with empty / placeholder
    // strings where the template expected real fields.
    enrichContinuationContext(ctx, templateName, state, cursor, { pluginRoot: PLUGIN_ROOT });

    const rendered = render(readPromptFile(templateName, PLUGIN_ROOT), ctx);

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
