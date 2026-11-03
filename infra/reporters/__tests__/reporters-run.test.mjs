import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..');
const out = mkdtempSync(join(tmpdir(), 'compact-reporter-'));

afterAll(() => {
  rmSync(out, { recursive: true, force: true });
});

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, FORCE_COLOR: '0', CI: '', FIXTURE_OUT: out },
    timeout: 120_000,
  });
  return { status: result.status, lines: `${result.stdout}${result.stderr}`.trim().split('\n') };
}

describe('the compact reporters, on a planted run', { timeout: 120_000 }, () => {
  it('Playwright: totals, then each failure with its message and file:line, nothing else', () => {
    const { status, lines } = run('npx', ['playwright', 'test', '-c', join(here, 'fixtures', 'playwright', 'playwright.config.mjs')]);
    expect(status).toBe(1);
    expect(lines[0]).toMatch(/^fixture: 1 passed, 2 failed, 1 skipped \(\d+s\)$/);
    expect(lines).toContain('✗ compares a number  infra/reporters/__tests__/fixtures/playwright/sample.fixture.mjs:8');
    expect(lines).toContain('✗ a group › throws its own error  infra/reporters/__tests__/fixtures/playwright/sample.fixture.mjs:17');
    expect(lines.some((line) => line.includes('the sum'))).toBe(true);
    expect(lines.some((line) => line.includes('the planted failure'))).toBe(true);
    expect(lines).toContain('    steps: ✗ the sum');
    expect(lines.some((line) => /^\s+at /.test(line))).toBe(false);
    expect(lines.length).toBeLessThanOrEqual(40);
    const whole = lines.find((line) => line.startsWith('whole messages: '));
    expect(whole).toBeDefined();
    expect(readFileSync(join(repo, (whole ?? '').slice('whole messages: '.length)), 'utf8')).toContain('the planted failure');
  });

  it('vitest: totals, then the failure with its diff lines and file:line, and a shuffled run ends with its seed and how to replay it', () => {
    const config = join(here, 'fixtures', 'vitest', 'vitest.config.mjs');
    const { status, lines } = run('npx', ['vitest', 'run', '-c', config]);
    expect.soft(status, 'in order').toBe(1);
    expect.soft(lines[0], 'in order').toMatch(/^vitest vitest: 1 files, 1 passed, 1 failed, 1 skipped \(\d+s\)$/);
    expect
      .soft(lines[1], 'in order')
      .toBe('✗ infra/reporters/__tests__/fixtures/vitest/sample.fixture.mjs › a group > compares an object  infra/reporters/__tests__/fixtures/vitest/sample.fixture.mjs:9');
    expect.soft(lines, 'in order').toContain('    -   "a": 2,');
    expect.soft(lines, 'in order').toContain('    +   "a": 1,');
    expect.soft(lines.length, 'in order').toBeLessThanOrEqual(10);
    expect.soft(lines.some((line) => line.includes('seed')), 'in order').toBe(false);

    const shuffled = run('npx', ['vitest', 'run', '-c', config, '--sequence.shuffle', '--sequence.seed=4242']);
    expect.soft(shuffled.status, 'shuffled').toBe(1);
    expect.soft(shuffled.lines[0], 'shuffled').toMatch(/^vitest vitest: 1 files, 1 passed, 1 failed, 1 skipped \(\d+s\)$/);
    expect.soft(shuffled.lines.at(-1), 'shuffled').toBe('vitest vitest: shuffled with seed 4242, rerun with --sequence.seed=4242');
  });

  it('vitest: an error thrown after a test names the file and the test it came from, with its stack when no frame is ours', () => {
    const { status, lines } = run('npx', ['vitest', 'run', '-c', join(here, 'fixtures', 'vitest-unhandled', 'vitest.config.mjs')]);
    expect(status).toBe(1);
    expect(lines[0]).toMatch(/^vitest vitest-unhandled: 1 files, 1 passed, 1 unhandled errors \(\d+s\)$/);
    expect(lines[1]).toBe('✗ unhandled error › infra/reporters/__tests__/fixtures/vitest-unhandled/teardown.fixture.mjs › leaves a timer behind');
    expect(lines).toContain('    ReferenceError: window is not defined');
    expect(lines).toContain('    at flush (/repo/node_modules/react-dom/cjs/react-dom.development.js:10:5)');
    const whole = lines.find((line) => line.startsWith('whole messages: '));
    expect(whole).toBeDefined();
    const text = readFileSync(join(repo, (whole ?? '').slice('whole messages: '.length)), 'utf8');
    expect(text).toContain('at Timeout._onTimeout (/repo/node_modules/scheduler/index.js:3:1)');
  });
});
