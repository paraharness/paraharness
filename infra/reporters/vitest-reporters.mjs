import { fileURLToPath } from 'node:url';

const COMPACT = fileURLToPath(new URL('./compact-vitest.mjs', import.meta.url));

export const vitestReporters = (env = process.env) => [env.VERBOSE === '1' ? 'default' : COMPACT, ...(env.GITHUB_ACTIONS === 'true' ? ['github-actions'] : [])];
