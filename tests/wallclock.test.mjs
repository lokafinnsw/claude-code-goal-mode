import { describe, it, expect } from 'vitest';
import { wallclockMinutes } from '../engine/wallclock.mjs';

describe('wallclockMinutes', () => {
  it('returns whole minutes elapsed since started_at', () => {
    const state = {
      budget: { wallclock: { started_at: '2026-05-09T22:00:00.000Z' } },
    };
    const now = new Date('2026-05-09T22:30:00.000Z').getTime();
    expect(wallclockMinutes(state, now)).toBe(30);
  });

  it('clamps to 0 on clock-skew (started_at in the future)', () => {
    const state = {
      budget: { wallclock: { started_at: '2026-05-10T00:00:00.000Z' } },
    };
    const now = new Date('2026-05-09T22:00:00.000Z').getTime();
    expect(wallclockMinutes(state, now)).toBe(0);
  });

  it('returns 0 on invalid date string (Bug 1 regression)', () => {
    const state = {
      budget: { wallclock: { started_at: 'not-a-date' } },
    };
    expect(wallclockMinutes(state, Date.now())).toBe(0);
  });

  it('returns 0 on empty started_at (Bug 1 edge case)', () => {
    const state = {
      budget: { wallclock: { started_at: '' } },
    };
    expect(wallclockMinutes(state, Date.now())).toBe(0);
  });

  it('uses Date.now() as default for now parameter', () => {
    const state = {
      budget: { wallclock: { started_at: new Date(Date.now() - 120_000).toISOString() } },
    };
    expect(wallclockMinutes(state)).toBe(2);
  });
});
