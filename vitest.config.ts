import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const packages = [
  'lockfile',
  'core',
  'sqlite',
  'postgres',
  'fs',
  'markdown',
  'node',
  'git',
  'claude',
  'openai',
  'gemini',
  'github',
  'slack',
] as const;

const testPackages = ['stripe', 'netsuite', 'integration'] as const;

const alias: Record<string, string> = {
  '@paraharness/core/runtime': path.resolve(rootDir, 'packages/core/src/runtime/index.ts'),
};

for (const pkg of packages) {
  alias[`@paraharness/${pkg}`] = path.resolve(rootDir, `packages/${pkg}/src/index.ts`);
}

for (const pkg of testPackages) {
  alias[`@paraharness/${pkg}`] = path.resolve(rootDir, `tests/${pkg}/src/index.ts`);
}

export default defineConfig({
  resolve: {
    alias,
  },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'tests/*/test/**/*.test.ts', 'test/**/*.test.ts'],
  },
});
