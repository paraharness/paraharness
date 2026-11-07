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
  'stripe',
  'netsuite',
  'integration',
] as const;

const alias: Record<string, string> = {
  '@harness-dsl/core/runtime': path.resolve(rootDir, 'packages/core/src/runtime/index.ts'),
};

for (const pkg of packages) {
  alias[`@harness-dsl/${pkg}`] = path.resolve(rootDir, `packages/${pkg}/src/index.ts`);
}

export default defineConfig({
  resolve: {
    alias,
  },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'test/**/*.test.ts'],
  },
});
