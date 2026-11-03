import { expect, test } from '@playwright/test';

test('adds up', () => {
  expect(1 + 1).toBe(2);
});

test('compares a number', () => {
  expect(2 + 2, 'the sum').toBe(5);
});

test('is skipped', () => {
  test.skip(true, 'on purpose');
});

test.describe('a group', () => {
  test('throws its own error', () => {
    throw new Error('the planted failure');
  });
});
