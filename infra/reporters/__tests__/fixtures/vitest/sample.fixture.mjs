import { describe, expect, it } from 'vitest';

describe('a group', () => {
  it('adds up', () => {
    expect(1 + 1).toBe(2);
  });

  it('compares an object', () => {
    expect({ a: 1, b: [1, 2] }).toEqual({ a: 2, b: [1, 2] });
  });

  it.skip('is skipped', () => {});
});
