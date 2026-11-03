import { configDefaults, defineConfig } from 'vitest/config';

import { vitestReporters } from './reporters/vitest-reporters.mjs';

const reporters = vitestReporters();

export default defineConfig({
  test: {
    reporters,
    include: [
      'scripts/__tests__/**/*.test.mjs',
      'session/__tests__/**/*.test.mjs',
      'watch/__tests__/**/*.test.mjs',
      'reporters/__tests__/**/*.test.mjs',
      'verify/__tests__/**/*.test.mjs',
    ],
    exclude: [...configDefaults.exclude],
    environment: 'node',
    forceRerunTriggers: ['**/infra/vitest.config.mts'],
    sequence: { shuffle: true },
  },
});
