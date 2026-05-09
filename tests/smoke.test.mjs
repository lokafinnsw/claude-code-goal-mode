import { describe, it, expect } from 'vitest';

describe('repo smoke', () => {
  it('node ESM works', () => {
    expect(1 + 1).toBe(2);
  });
});
