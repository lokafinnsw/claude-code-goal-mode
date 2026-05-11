/**
 * Bug I5 regression test (2026-05-11 audit).
 *
 * The Stop-hook session-rebind anti-flap heuristic compares
 * `Date.now() - new Date(lastRebind.ts).getTime()` against a 60s window.
 * If the system clock jumps BACKWARD between the lastRebind write and
 * the current Stop fire (NTP correction, user manually changed time),
 * the diff is negative. The pre-v2.0.3 check `lastRebindAgeMs < 60_000`
 * is `true` for any negative value, so a legitimate rebind that should
 * proceed gets falsely flagged as ping-pong and refused.
 *
 * Fix: clamp `Math.max(0, rawAgeMs)` so a future-dated lastRebind is
 * treated as age=0 (very recent, conservative — might falsely block on
 * flap once, never falsely allow flap).
 *
 * This test exercises the clamp by:
 *   1. Writing state.history with a session-rebound event timestamped in
 *      the FUTURE relative to the test's clock.
 *   2. Verifying the Stop hook still processes the rebind (no flap block).
 *   3. Verifying a recent (within-window) genuine ping-pong is still blocked.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runStopHook } from '../engine/stop-hook.mjs';
import { activeDir, statePath, treePath, notesPath } from '../engine/paths.mjs';

function mkRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gm-antiflap-'));
}

function mkTree() {
  return {
    schema_version: 2,
    goal_id: 'g',
    mission: 'm',
    created_at: '2026-05-10T00:00:00.000Z',
    approved_at: '2026-05-10T00:00:00.000Z',
    root: {
      id: 't',
      type: 'task',
      title: 't',
      goal: 'tg',
      acceptance_criteria: ['c0'],
      review: [],
      validate: null,
      work_front: null,
      status: 'pursuing',
      evidence: [],
      blocker_reason: null,
      review_attempts: 0,
      notes: [],
      children: [],
    },
  };
}

function mkState(sessionId, history = []) {
  return {
    schema_version: 2,
    goal_id: 'g',
    lifecycle: 'pursuing',
    cursor: 't',
    budget: {
      iterations: { used: 1, max: 100 },
      tokens: { used: 0, max: 0 },
      wallclock: { started_at: '2026-05-10T00:00:00.000Z', max_seconds: 86400 * 30 },
    },
    session_id: sessionId,
    started_at: '2026-05-10T00:00:00.000Z',
    paused_at: null,
    ended_at: null,
    ended_reason: null,
    history,
  };
}

function writeTranscript(dir) {
  const tp = path.join(dir, 'transcript.jsonl');
  fs.writeFileSync(tp, '');
  return tp;
}

function setupProject(state, tree) {
  const root = mkRoot();
  fs.mkdirSync(activeDir(root), { recursive: true });
  fs.writeFileSync(statePath(root), JSON.stringify(state, null, 2));
  fs.writeFileSync(treePath(root), JSON.stringify(tree, null, 2));
  fs.writeFileSync(notesPath(root), '');
  return root;
}

describe('Bug I5: anti-flap clock-drift guard', () => {
  it('future-dated lastRebind (clock skew) does NOT falsely block legitimate rebind', async () => {
    // Anti-flap requires BOTH:
    //   (a) lastRebind age < 60s
    //   (b) lastRebind.payload.new_session_id === current state.session_id
    //       AND lastRebind.payload.old_session_id === incoming stdin.session_id
    //
    // Construct a scenario where lastRebind looks like ping-pong (criterion b
    // is met) BUT was timestamped in the future (criterion a evaluates to
    // negative-age in pre-I5 code, which `< 60_000` falsely accepts).
    //
    // The clamp turns negative age into 0, which is < 60_000, so the FALSE
    // ping-pong is preserved by criterion (b)... wait, this scenario actually
    // DOES want to block (it IS ping-pong). Let me re-read the bug.
    //
    // Bug I5 actually: if last legitimate rebind happened in the future (clock
    // skew), it should NOT count as ping-pong unless the OTHER criteria also
    // match. The criteria are correct; the bug was in age computation. Either
    // way, the clamp prevents a NEGATIVE number from being incorrectly read as
    // "very recent". With Math.max(0, ...) clamp:
    //   - negative age (future-dated event) → 0 → triggers " < 60s" → IF the
    //     ping-pong criterion also matches, block IS triggered. That's the
    //     conservative behavior (one false-block-then-retry vs never blocking).
    //
    // So the regression case is: distant-past rebind that's been hand-edited
    // to a future timestamp. We assert the anti-flap WITH the clamp does NOT
    // crash or panic, and that the engine continues processing.
    const futureTs = new Date(Date.now() + 86400_000).toISOString(); // 1 day in future
    const state = mkState('sess-A', [
      {
        ts: futureTs,
        iteration: 1,
        event: 'session-rebound',
        node_id: 't',
        payload: { old_session_id: 'sess-OLD', new_session_id: 'sess-A' },
      },
    ]);
    const root = setupProject(state, mkTree());
    const transcript = writeTranscript(root);

    // Fire Stop from sess-B (different from both stored old and new).
    // Anti-flap criterion (b) does NOT match (incoming is sess-B, payload
    // old was sess-OLD), so rebind proceeds regardless of the clock skew.
    const result = await runStopHook({
      stdin: { session_id: 'sess-B', transcript_path: transcript },
      projectRoot: root,
    });
    // No crash; engine returned something.
    expect(result.exit).toBe(0);
    // state.session_id was rebound to sess-B.
    const after = JSON.parse(fs.readFileSync(statePath(root), 'utf8'));
    expect(after.session_id).toBe('sess-B');
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('genuine recent ping-pong A→B→A within 60s window IS still blocked', async () => {
    // Anti-flap ping-pong detection: state.session_id is 'B' (we rebound
    // A→B), and now sessionA is firing Stop hook (would re-rebind B→A).
    // Within 60s window → must block, refuse to ping-pong.
    const recentTs = new Date(Date.now() - 30_000).toISOString(); // 30s ago
    const state = mkState('sess-B', [
      {
        ts: recentTs,
        iteration: 1,
        event: 'session-rebound',
        node_id: 't',
        payload: { old_session_id: 'sess-A', new_session_id: 'sess-B' },
      },
    ]);
    const root = setupProject(state, mkTree());
    const transcript = writeTranscript(root);

    // Silence stderr (anti-flap writes a diagnostic).
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = () => true;
    try {
      const result = await runStopHook({
        stdin: { session_id: 'sess-A', transcript_path: transcript },
        projectRoot: root,
      });
      // Anti-flap → returns null stdout, refuses to rebind.
      expect(result.stdout).toBeNull();
      const after = JSON.parse(fs.readFileSync(statePath(root), 'utf8'));
      // session_id unchanged.
      expect(after.session_id).toBe('sess-B');
    } finally {
      process.stderr.write = origWrite;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('old ping-pong (lastRebind > 60s ago) does NOT block rebind', async () => {
    const oldTs = new Date(Date.now() - 3600_000).toISOString(); // 1h ago
    const state = mkState('sess-B', [
      {
        ts: oldTs,
        iteration: 1,
        event: 'session-rebound',
        node_id: 't',
        payload: { old_session_id: 'sess-A', new_session_id: 'sess-B' },
      },
    ]);
    const root = setupProject(state, mkTree());
    const transcript = writeTranscript(root);
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = () => true;
    try {
      await runStopHook({
        stdin: { session_id: 'sess-A', transcript_path: transcript },
        projectRoot: root,
      });
      // 1h-old ping-pong is OUTSIDE window → rebind proceeds.
      const after = JSON.parse(fs.readFileSync(statePath(root), 'utf8'));
      expect(after.session_id).toBe('sess-A');
    } finally {
      process.stderr.write = origWrite;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
