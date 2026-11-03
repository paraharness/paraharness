import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export default {
  testDir: here,
  testMatch: '*.fixture.mjs',
  outputDir: process.env.FIXTURE_OUT ?? join(here, 'test-results'),
  retries: 0,
  workers: 1,
  captureGitInfo: { commit: false, diff: false },
  reporter: [[join(here, '..', '..', '..', 'compact-playwright.mjs'), { name: 'fixture' }]],
};
