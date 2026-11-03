import { describe, expect, it } from 'vitest';

import { countsLine, duration, failureBlock, firstAppFrame, messageLines, stripAnsi } from '../compact-lib.mjs';

describe('compact-lib', () => {
  it('strips colour codes', () => {
    expect(stripAnsi('\u001b[31mred\u001b[39m plain')).toBe('red plain');
  });

  it('says a duration in seconds, then minutes', () => {
    expect(duration(4_400)).toBe('4s');
    expect(duration(372_000)).toBe('6m12s');
  });

  it('names the first frame in the repository, never one in node_modules', () => {
    const stack = [
      'Error: boom',
      '    at helper (/repo/node_modules/lib/index.js:10:5)',
      '    at Object.<anonymous> (/repo/apps/app/e2e/home.spec.ts:42:7)',
      '    at next (/repo/apps/app/e2e/helpers.ts:9:1)',
    ].join('\n');
    expect(firstAppFrame(stack, '/repo')).toBe('apps/app/e2e/home.spec.ts:42');
    expect(firstAppFrame('no frames here', '/repo')).toBeNull();
  });

  it('keeps the message and drops the stack, the call log and blank lines, and caps a long message saying how much it left out', () => {
    const message = [
      'expect(received).toBe(expected)',
      '',
      'Expected: 2',
      'Received: 3',
      'Call log:',
      '  - waiting for getByTestId("x")',
      '    at /repo/a.ts:1:1',
    ].join('\n');
    expect.soft(messageLines(message), 'stack and call log').toEqual(['expect(received).toBe(expected)', 'Expected: 2', 'Received: 3']);
    const long = Array.from({ length: 20 }, (_, index) => `line ${String(index)}`).join('\n');
    const lines = messageLines(long, 6);
    expect.soft(lines, 'capped').toHaveLength(6);
    expect.soft(lines[5], 'capped').toBe('… 15 more line(s)');
  });

  it('says the counts on one line, leaving out the zeros', () => {
    expect(countsLine('e2e', { passed: 10, failed: 0, flaky: 0, skipped: 0 }, 1_000)).toBe('e2e: 10 passed (1s)');
    expect(countsLine('vitest app', { files: 3, passed: 9, failed: 1, flaky: 0, skipped: 2 }, 61_000)).toBe(
      'vitest app: 3 files, 9 passed, 1 failed, 2 skipped (1m01s)',
    );
    expect(countsLine('vitest app', { files: 1, passed: 4, failed: 0, flaky: 0, skipped: 0, errors: 1 }, 0)).toBe(
      'vitest app: 1 files, 4 passed, 1 unhandled errors (0s)',
    );
  });

  it('prints messages within the budget and names every other failure on its own line', () => {
    const failures = Array.from({ length: 30 }, (_, index) => ({
      title: `test ${String(index)}`,
      where: `a.spec.ts:${String(index)}`,
      lines: ['one', 'two', 'three'],
    }));
    const out = failureBlock(failures, 20);
    expect(out[0]).toBe('✗ test 0  a.spec.ts:0');
    expect(out.filter((line) => line.startsWith('    ')).length).toBeLessThanOrEqual(20);
    for (let index = 0; index < 30; index += 1) {
      expect(out).toContain(`✗ test ${String(index)}  a.spec.ts:${String(index)}`);
    }
  });
});
