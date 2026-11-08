/**
 * Ordered list of relative monorepo directories to create inside `repoDir` for integration workspace fixtures.
 *
 * Covers `packages/{db,api,web}`, `.harness/{bin,rules,skills,prompts,lessons}`, and `node_modules`.
 */
export const SEED_RELATIVE_DIRS: readonly string[] = Object.freeze([
  'packages/db/src',
  'packages/db/migrations',
  'packages/api/src',
  'packages/api/test',
  'packages/web/src',
  '.harness/bin',
  '.harness/rules/global',
  '.harness/rules/scoped',
  '.harness/skills/db-migrations',
  '.harness/skills/ui-verification',
  '.harness/skills/shared',
  '.harness/prompts',
  '.harness/lessons',
  'node_modules',
]);

/**
 * Ordered list of `(relativePath, content)` pairs seeded into `repoDir` for integration workspace fixtures.
 *
 * Provides initial specifications, package sources, tests, Markdown rules, skills, and actor prompts.
 */
export const SEED_MONOREPO_FILES: ReadonlyArray<readonly [string, string]> = Object.freeze([
  ['PRODUCT_SPEC.md', '# Product Spec\nUsers have `id` and `email`.\n'],
  [
    'TECH_DESIGN.md',
    '# Tech Design\nPartition DAG: `db` -> `api` -> `web`.\n`db` exports `UserRecord` and `queryUser`.\n',
  ],
  ['openapi.yaml', 'openapi: 3.1.0\ninfo:\n  title: Acme API\n  version: 1.0.0\n'],
  ['pnpm-lock.yaml', 'lockfileVersion: 9.0\n'],
  ['.gitignore', 'node_modules/\n.harness/workspaces/\n.harness/state.sqlite*\n'],
  [
    'packages/db/src/index.ts',
    "export interface UserRecord {\n  id: string;\n  email: string;\n}\nexport function queryUser(id: string): UserRecord {\n  return { id, email: `${id}@acme.test` };\n}\n",
  ],
  [
    'packages/api/src/user-endpoint.ts',
    "import { queryUser } from '../../db/src/index.ts';\nexport function getUserEndpoint(id: string): string {\n  return queryUser(id).email;\n}\n",
  ],
  ['packages/api/src/index.ts', "export { getUserEndpoint } from './user-endpoint.ts';\n"],
  [
    'packages/api/test/index.test.ts',
    "import assert from 'node:assert/strict';\nimport { getUserEndpoint } from '../src/index.ts';\nassert.equal(getUserEndpoint('u1'), 'u1@acme.test');\n",
  ],
  ['packages/web/src/index.ts', "export const WEB_TITLE = 'Acme Portal';\n"],
  [
    '.harness/bin/cdp-repl.ts',
    "import readline from 'node:readline';\nconst cdpPort = Number(process.argv[2] ?? '0');\nconst rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });\nprocess.stdout.write('cdp> ');\nrl.on('line', (line: string) => {\n  process.stdout.write(JSON.stringify({ cdpPort, command: line.trim(), title: 'Acme Portal' }) + '\\ncdp> ');\n});\n",
  ],
  [
    '.harness/rules/global/code-style.md',
    '---\nid: clean-exports\n---\nExport explicit functions from partition index files.\n',
  ],
  [
    '.harness/rules/scoped/web-a11y.md',
    '---\nid: web-a11y\npartitions:\n  - web\nglobs:\n  - packages/web/**/*.tsx\n---\nEnsure semantic landmarks on interactive views.\n',
  ],
  [
    '.harness/rules/api-orm-boundary.md',
    'Never import drizzle-orm directly inside packages/api.\n',
  ],
  [
    '.harness/rules/db-migrations.md',
    '---\nid: db-migrations-rule\npartitions:\n  - db\nglobs:\n  - packages/db/migrations/*.sql\n---\nNever drop columns without owner approval.\n',
  ],
  [
    '.harness/skills/db-migrations/SKILL.md',
    '---\nid: db-migrations\npartitions:\n  - db\ndescription: Generate and verify Drizzle SQL migrations.\n---\nRun drizzle-generate after updating schema.\n',
  ],
  [
    '.harness/skills/ui-verification/instructions.md',
    'Verify UI layouts in headless browser sandbox.\n',
  ],
  [
    '.harness/skills/shared/tdd.md',
    '---\nid: shared-tdd\ndescription: Test-driven workflow.\n---\nRun verify-suite before stopping.\n',
  ],
  ['.harness/prompts/base-posture.md', 'Follow repository architecture and rules.\n'],
  ['.harness/prompts/worker.md', 'Implement the assigned partition task.\n'],
  ['.harness/prompts/evaluator.md', 'Audit candidate diff against acceptance criteria.\n'],
  ['.harness/prompts/lease-adjudicator.md', 'Adjudicate existing test write lease requests.\n'],
  ['.harness/prompts/candidate-arbiter.md', 'Compare speculative candidate branches.\n'],
  ['.harness/prompts/coordinator.md', 'Coordinate multi-partition architecture and forks.\n'],
  ['.harness/prompts/lesson-distiller.md', 'Distill concise preventative lessons from recovery.\n'],
  ['node_modules/.keep', 'warm\n'],
]);

/**
 * Executable Node.js CLI shim script emulating `pnpm install`, `dev:headless`, `tsx`, and `pnpm test` across partitions.
 *
 * Runs `.test.ts` suites via `node --experimental-strip-types` and emits circuit-breaker-compatible failure lines.
 */
export const PNPM_SHIM_SCRIPT = [
  '#!/usr/bin/env node',
  "const fs = require('node:fs');",
  "const path = require('node:path');",
  "const cp = require('node:child_process');",
  "const net = require('node:net');",
  "const readline = require('node:readline');",
  'const args = process.argv.slice(2);',
  "if (args[0] === 'install') {",
  '  process.exit(0);',
  '}',
  "if (args.includes('dev:headless')) {",
  '  const getPort = (flag) => Number(args[args.indexOf(flag) + 1]);',
  "  const s1 = net.createServer().listen(getPort('--port'), '127.0.0.1');",
  "  const s2 = net.createServer().listen(getPort('--remote-debugging-port'), '127.0.0.1');",
  '  Promise.all([',
  "    new Promise((r) => s1.once('listening', r)),",
  "    new Promise((r) => s2.once('listening', r)),",
  "  ]).then(() => process.stdout.write('Ready in 12ms\\n'));",
  '  setInterval(() => {}, 60000);',
  '  return;',
  '}',
  "if (args[0] === 'tsx') {",
  "  const cdpPort = Number(args[2] || '0');",
  '  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });',
  "  process.stdout.write('cdp> ');",
  "  rl.on('line', (line) => {",
  "    process.stdout.write(JSON.stringify({ cdpPort, command: line.trim(), title: 'Acme Portal' }) + '\\ncdp> ');",
  '  });',
  '  return;',
  '}',
  "if (args[0] === 'test' || args[0] === 'verify') {",
  "  for (const pkg of ['db', 'api', 'web']) {",
  "    const tDir = path.join(process.cwd(), 'packages', pkg, 'test');",
  '    if (!fs.existsSync(tDir)) continue;',
  "    for (const f of fs.readdirSync(tDir).filter((n) => n.endsWith('.test.ts'))) {",
  '      const r = cp.spawnSync(',
  "        process.execPath,",
  "        ['--experimental-strip-types', path.join(tDir, f)],",
  "        { cwd: process.cwd(), encoding: 'utf8' },",
  '      );',
  '      if (r.status !== 0) {',
  "        const detail = r.stderr || r.stdout || 'Assertion failed';",
  "        process.stdout.write('FAIL packages/' + pkg + '/test/' + f + '\\n  ● ' + detail + '\\n');",
  '        process.exit(1);',
  '      }',
  '    }',
  '  }',
  "  process.stdout.write('PASS all suites\\n');",
  '  process.exit(0);',
  '}',
  'process.exit(0);',
  '',
].join('\n');
