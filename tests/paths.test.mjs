import { describe, it, expect } from 'vitest';
import { goalsDir, treePath, statePath, notesPath, planPath, auditsDir, archiveDir } from '../engine/paths.mjs';

describe('paths', () => {
  it('returns expected relative paths for a project root', () => {
    const root = '/repo';
    expect(goalsDir(root)).toBe('/repo/.claude/goals');
    expect(treePath(root)).toBe('/repo/.claude/goals/active/tree.json');
    expect(statePath(root)).toBe('/repo/.claude/goals/active/state.json');
    expect(notesPath(root)).toBe('/repo/.claude/goals/active/notes.md');
    expect(planPath(root)).toBe('/repo/.claude/goals/active/plan.md');
    expect(auditsDir(root)).toBe('/repo/.claude/goals/active/audits');
    expect(archiveDir(root)).toBe('/repo/.claude/goals/archive');
  });
});
