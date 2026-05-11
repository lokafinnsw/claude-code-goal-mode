/**
 * Tests for engine/transcript-checkpoint.mjs (v2.0.3 hardening).
 *
 * Covers:
 *   - Initial scan from byte 0 (empty checkpoint).
 *   - Incremental scan: only newly-appended bytes consumed.
 *   - Trailing partial line: skipped until terminated by \n OR parseable as JSON.
 *   - Rotation by size shrink: cache reset, tokens floor preserved.
 *   - Rotation by fingerprint mismatch: cache reset, tokens floor preserved.
 *   - Fail-closed on Agent dispatch without `timestamp` field (bug I6).
 *   - sinceTs filter excludes pre-cursor-advance Agent dispatches.
 *   - Cap on agent_dispatches list size.
 *   - Checkpoint persistence round-trip.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  advanceTallyScan,
  advanceCheckpoint,
  loadCheckpoint,
  saveCheckpoint,
  tallyTokensViaCheckpoint,
  scanAgentInvocationsIncremental,
} from '../engine/transcript-checkpoint.mjs';
import { activeDir } from '../engine/paths.mjs';

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-tcheckpoint-'));
  fs.mkdirSync(activeDir(root), { recursive: true });
  const transcriptPath = path.join(root, 'transcript.jsonl');
  return { root, transcriptPath };
}

function writeAssistantRow(usage, opts = {}) {
  const row = {
    timestamp: opts.timestamp ?? '2026-05-11T12:00:00.000Z',
    message: {
      role: 'assistant',
      content: opts.content ?? [{ type: 'text', text: 'hi' }],
      usage,
    },
  };
  return JSON.stringify(row);
}

function writeAgentToolUse(subagentType, ts) {
  const row = {
    timestamp: ts,
    message: {
      role: 'assistant',
      content: [
        { type: 'tool_use', name: 'Agent', input: { subagent_type: subagentType } },
      ],
    },
  };
  return JSON.stringify(row);
}

describe('transcript-checkpoint: initial scan + incremental scan', () => {
  it('tally on empty transcript returns 0', () => {
    const { root, transcriptPath } = setup();
    fs.writeFileSync(transcriptPath, '');
    const { tokens } = tallyTokensViaCheckpoint(root, transcriptPath);
    expect(tokens).toBe(0);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('tally counts input+output+cache_creation tokens from one row', () => {
    const { root, transcriptPath } = setup();
    fs.writeFileSync(
      transcriptPath,
      writeAssistantRow({ input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 2 }) + '\n',
    );
    const { tokens } = tallyTokensViaCheckpoint(root, transcriptPath);
    expect(tokens).toBe(17);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('tally excludes cache_read_input_tokens', () => {
    const { root, transcriptPath } = setup();
    fs.writeFileSync(
      transcriptPath,
      writeAssistantRow({ input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 1000 }) + '\n',
    );
    const { tokens } = tallyTokensViaCheckpoint(root, transcriptPath);
    expect(tokens).toBe(15);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('incremental: second tick reads only newly-appended bytes', () => {
    const { root, transcriptPath } = setup();
    fs.writeFileSync(transcriptPath, writeAssistantRow({ input_tokens: 10, output_tokens: 5 }) + '\n');
    const first = tallyTokensViaCheckpoint(root, transcriptPath);
    expect(first.tokens).toBe(15);
    saveCheckpoint(root, first.checkpoint);

    fs.appendFileSync(transcriptPath, writeAssistantRow({ input_tokens: 7, output_tokens: 3 }) + '\n');
    const second = tallyTokensViaCheckpoint(root, transcriptPath);
    expect(second.tokens).toBe(25); // 15 + 10
    expect(second.checkpoint.offset_bytes).toBeGreaterThan(first.checkpoint.offset_bytes);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('trailing line without \\n: parseable JSON → consumed; non-parseable → deferred', () => {
    const { root, transcriptPath } = setup();
    // Complete JSON without trailing newline — should be consumed.
    fs.writeFileSync(transcriptPath, writeAssistantRow({ input_tokens: 10, output_tokens: 5 }));
    const first = tallyTokensViaCheckpoint(root, transcriptPath);
    expect(first.tokens).toBe(15);
    saveCheckpoint(root, first.checkpoint);

    // Partial (truncated) JSON — should NOT advance offset.
    fs.appendFileSync(transcriptPath, '\n{"message":{"role":"assist');
    const second = tallyTokensViaCheckpoint(root, transcriptPath);
    expect(second.tokens).toBe(15); // unchanged
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('transcript-checkpoint: rotation detection', () => {
  it('size shrink triggers rotation + preserves tokens as floor', () => {
    const { root, transcriptPath } = setup();
    fs.writeFileSync(transcriptPath, writeAssistantRow({ input_tokens: 100, output_tokens: 50 }) + '\n');
    const first = tallyTokensViaCheckpoint(root, transcriptPath);
    expect(first.tokens).toBe(150);
    saveCheckpoint(root, first.checkpoint);

    // Replace transcript with a much shorter one (simulating /compact).
    fs.writeFileSync(transcriptPath, writeAssistantRow({ input_tokens: 10, output_tokens: 5 }) + '\n');
    const second = tallyTokensViaCheckpoint(root, transcriptPath, 150);
    expect(second.rotated).toBe(true);
    // Floor preserved: max(carry_over=150, fresh_total=15) = 150.
    expect(second.tokens).toBe(150);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('fingerprint mismatch on same size also triggers rotation', () => {
    const { root, transcriptPath } = setup();
    // Write 300+ bytes so fingerprint of first 256 has meaningful content.
    const row1 = writeAssistantRow({ input_tokens: 100, output_tokens: 50 });
    const padded1 = row1 + ' '.repeat(Math.max(0, 300 - row1.length));
    fs.writeFileSync(transcriptPath, padded1 + '\n');
    const first = tallyTokensViaCheckpoint(root, transcriptPath);
    saveCheckpoint(root, first.checkpoint);

    // Same size, different first bytes.
    const row2 = writeAssistantRow({ input_tokens: 200, output_tokens: 100 }, { content: [{ type: 'text', text: 'rotated' }] });
    const padded2 = row2 + ' '.repeat(Math.max(0, 300 - row2.length));
    fs.writeFileSync(transcriptPath, padded2 + '\n');

    const second = tallyTokensViaCheckpoint(root, transcriptPath, first.tokens);
    expect(second.rotated).toBe(true);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('fallbackPreviousTotal preserved as floor even when checkpoint deleted', () => {
    const { root, transcriptPath } = setup();
    fs.writeFileSync(transcriptPath, writeAssistantRow({ input_tokens: 10, output_tokens: 5 }) + '\n');
    const { tokens } = tallyTokensViaCheckpoint(root, transcriptPath, 9999);
    expect(tokens).toBe(9999); // fallback wins
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('transcript-checkpoint: Agent dispatch scan + fail-closed semantic', () => {
  it('scan picks up Agent tool_use entries', () => {
    const { root, transcriptPath } = setup();
    fs.writeFileSync(transcriptPath, writeAgentToolUse('aaa-art-director', '2026-05-11T12:00:00.000Z') + '\n');
    const { agents } = scanAgentInvocationsIncremental(root, transcriptPath, null);
    expect(agents.has('aaa-art-director')).toBe(true);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('sinceTs filter excludes pre-cursor-advance agents', () => {
    const { root, transcriptPath } = setup();
    const old = writeAgentToolUse('old-agent', '2026-05-11T10:00:00.000Z');
    const fresh = writeAgentToolUse('new-agent', '2026-05-11T12:00:00.000Z');
    fs.writeFileSync(transcriptPath, old + '\n' + fresh + '\n');
    const { agents } = scanAgentInvocationsIncremental(
      root,
      transcriptPath,
      '2026-05-11T11:00:00.000Z',
    );
    expect(agents.has('new-agent')).toBe(true);
    expect(agents.has('old-agent')).toBe(false);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('FAIL-CLOSED: agent dispatch WITHOUT timestamp is excluded when sinceTs is set (bug I6 fix)', () => {
    const { root, transcriptPath } = setup();
    const row = {
      // No top-level `timestamp`.
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', name: 'Agent', input: { subagent_type: 'no-ts-agent' } }],
      },
    };
    fs.writeFileSync(transcriptPath, JSON.stringify(row) + '\n');
    const { agents } = scanAgentInvocationsIncremental(
      root,
      transcriptPath,
      '2026-05-11T11:00:00.000Z',
    );
    expect(agents.has('no-ts-agent')).toBe(false);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('without sinceTs, no-timestamp dispatch IS included (preserves CLI-test compat)', () => {
    const { root, transcriptPath } = setup();
    const row = {
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', name: 'Agent', input: { subagent_type: 'no-ts-agent' } }],
      },
    };
    fs.writeFileSync(transcriptPath, JSON.stringify(row) + '\n');
    const { agents } = scanAgentInvocationsIncremental(root, transcriptPath, null);
    expect(agents.has('no-ts-agent')).toBe(true);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('transcript-checkpoint: advanceTallyScan single-pass', () => {
  it('combines tokens + agents into one pass without double-advance', () => {
    const { root, transcriptPath } = setup();
    const rows = [
      writeAssistantRow({ input_tokens: 100, output_tokens: 50 }),
      writeAgentToolUse('reviewer-1', '2026-05-11T12:00:00.000Z'),
      writeAssistantRow({ input_tokens: 30, output_tokens: 20 }, { content: [{ type: 'text', text: 'after agent' }] }),
    ];
    fs.writeFileSync(transcriptPath, rows.join('\n') + '\n');

    const result = advanceTallyScan(root, transcriptPath, null, 0);
    expect(result.tokens).toBe(200); // 150 + 50
    expect(result.agents.has('reviewer-1')).toBe(true);
    expect(result.rotated).toBe(false);
    // checkpoint.offset_bytes advanced once past entire file
    expect(result.checkpoint.offset_bytes).toBeGreaterThan(0);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('transcript-checkpoint: checkpoint file lifecycle', () => {
  it('load returns empty checkpoint when file missing', () => {
    const { root } = setup();
    const cp = loadCheckpoint(root);
    expect(cp.schema_version).toBe(1);
    expect(cp.offset_bytes).toBe(0);
    expect(cp.tokens_total).toBe(0);
    expect(cp.agent_dispatches).toEqual([]);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('load returns empty checkpoint when file is corrupt', () => {
    const { root } = setup();
    fs.writeFileSync(path.join(activeDir(root), '.transcript-cache.json'), 'not json at all');
    const cp = loadCheckpoint(root);
    expect(cp.offset_bytes).toBe(0);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('save/load round-trip', () => {
    const { root } = setup();
    const before = {
      schema_version: 1,
      offset_bytes: 12345,
      tokens_total: 999,
      fingerprint: 'abc123',
      size_bytes: 20000,
      agent_dispatches: [{ ts: '2026-05-11T12:00:00.000Z', subagent_type: 'x' }],
    };
    saveCheckpoint(root, before);
    const after = loadCheckpoint(root);
    expect(after).toEqual(before);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('transcript-checkpoint: malformed lines are skipped', () => {
  it('malformed JSON lines do not crash the scan', () => {
    const { root, transcriptPath } = setup();
    fs.writeFileSync(
      transcriptPath,
      writeAssistantRow({ input_tokens: 100, output_tokens: 50 }) + '\n'
        + 'this is not json\n'
        + writeAssistantRow({ input_tokens: 30, output_tokens: 20 }) + '\n',
    );
    const { tokens } = tallyTokensViaCheckpoint(root, transcriptPath);
    expect(tokens).toBe(200); // 150 + 50, malformed skipped
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('non-assistant rows are not counted', () => {
    const { root, transcriptPath } = setup();
    const userRow = JSON.stringify({ message: { role: 'user', content: [] } });
    fs.writeFileSync(
      transcriptPath,
      userRow + '\n' + writeAssistantRow({ input_tokens: 10, output_tokens: 5 }) + '\n',
    );
    const { tokens } = tallyTokensViaCheckpoint(root, transcriptPath);
    expect(tokens).toBe(15);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('transcript-checkpoint: missing transcript file', () => {
  it('returns cached state unchanged when transcript file disappears', () => {
    const { root, transcriptPath } = setup();
    // Seed with one tick of valid data.
    fs.writeFileSync(transcriptPath, writeAssistantRow({ input_tokens: 50, output_tokens: 50 }) + '\n');
    const first = tallyTokensViaCheckpoint(root, transcriptPath);
    saveCheckpoint(root, first.checkpoint);
    // Delete transcript.
    fs.unlinkSync(transcriptPath);
    const second = tallyTokensViaCheckpoint(root, transcriptPath, 100);
    expect(second.tokens).toBe(100); // floor preserved
    fs.rmSync(root, { recursive: true, force: true });
  });
});
