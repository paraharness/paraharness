import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openSqliteConnection } from '@harness-dsl/sqlite';
import type { IntegrationWorkspaceHandle } from './integration-workspace-handle.js';

/**
 * Creates a real temporary Git monorepo (`packages/{db,api,web}`), bare `origin` remote, and SQLite state store (`M4-integration.md` §5).
 *
 * Seeds `PRODUCT_SPEC.md`, `TECH_DESIGN.md`, `.harness/{rules,skills,prompts}/**`, `pnpm-lock.yaml`,
 * `node_modules/.keep`, and deterministic `pnpm` and `gh` CLI shims so `engineeringFlow` and `appHarness`
 * execute end-to-end against real Git worktrees, real SQLite stores, and real Node child processes.
 *
 * @returns {Promise<IntegrationWorkspaceHandle>} Initialized workspace handle with `readCreatedPrs()` and `cleanup()`.
 */
export async function createIntegrationWorkspaceFixture(): Promise<IntegrationWorkspaceHandle> {
  const previousCwd = process.cwd();
  const previousPath = process.env['PATH'] ?? '';
  const tempRootDir = await mkdtemp(path.join(os.tmpdir(), 'harness-m4-e2e-'));
  const repoDir = path.join(tempRootDir, 'repo');
  const remoteBareDir = path.join(tempRootDir, 'origin.git');
  const binDir = path.join(tempRootDir, 'bin');
  const ghPrsLogPath = path.join(tempRootDir, 'gh-prs.json');
  const dirs = [
    remoteBareDir, binDir, path.join(repoDir, 'packages/db/src'), path.join(repoDir, 'packages/db/migrations'),
    path.join(repoDir, 'packages/api/src'), path.join(repoDir, 'packages/api/test'), path.join(repoDir, 'packages/web/src'),
    path.join(repoDir, '.harness/bin'), path.join(repoDir, '.harness/rules/global'), path.join(repoDir, '.harness/rules/scoped'),
    path.join(repoDir, '.harness/skills/db-migrations'), path.join(repoDir, '.harness/skills/ui-verification'),
    path.join(repoDir, '.harness/skills/shared'), path.join(repoDir, '.harness/prompts'),
    path.join(repoDir, '.harness/lessons'), path.join(repoDir, 'node_modules'),
  ];
  for (const dir of dirs) await mkdir(dir, { recursive: true });
  await writeFile(ghPrsLogPath, '[]', 'utf8');
  const files: Readonly<Record<string, string>> = {
    'PRODUCT_SPEC.md': '# Product Spec\nUsers have `id` and `email`.\n',
    'TECH_DESIGN.md': '# Tech Design\nPartition DAG: `db` -> `api` -> `web`.\n`db` exports `UserRecord` and `queryUser`.\n',
    'openapi.yaml': 'openapi: 3.1.0\ninfo:\n  title: Acme API\n  version: 1.0.0\n',
    'pnpm-lock.yaml': 'lockfileVersion: 9.0\n',
    '.gitignore': 'node_modules/\n.harness/workspaces/\n.harness/state.sqlite*\n',
    'packages/db/src/index.ts': "export interface UserRecord {\n  id: string;\n  email: string;\n}\nexport function queryUser(id: string): UserRecord {\n  return { id, email: `${id}@acme.test` };\n}\n",
    'packages/api/src/user-endpoint.ts': "import { queryUser } from '../../db/src/index.ts';\nexport function getUserEndpoint(id: string): string {\n  return queryUser(id).email;\n}\n",
    'packages/api/src/index.ts': "export { getUserEndpoint } from './user-endpoint.ts';\n",
    'packages/api/test/index.test.ts': "import assert from 'node:assert/strict';\nimport { getUserEndpoint } from '../src/index.ts';\nassert.equal(getUserEndpoint('u1'), 'u1@acme.test');\n",
    'packages/web/src/index.ts': "export const WEB_TITLE = 'Acme Portal';\n",
    '.harness/bin/cdp-repl.ts': "import readline from 'node:readline';\nconst cdpPort = Number(process.argv[2] ?? '0');\nconst rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });\nprocess.stdout.write('cdp> ');\nrl.on('line', (line: string) => {\n  process.stdout.write(JSON.stringify({ cdpPort, command: line.trim(), title: 'Acme Portal' }) + '\\ncdp> ');\n});\n",
    '.harness/rules/global/code-style.md': '---\nid: clean-exports\n---\nExport explicit functions from partition index files.\n',
    '.harness/rules/scoped/web-a11y.md': '---\nid: web-a11y\npartitions:\n  - web\nglobs:\n  - packages/web/**/*.tsx\n---\nEnsure semantic landmarks on interactive views.\n',
    '.harness/rules/api-orm-boundary.md': 'Never import drizzle-orm directly inside packages/api.\n',
    '.harness/rules/db-migrations.md': '---\nid: db-migrations-rule\npartitions:\n  - db\nglobs:\n  - packages/db/migrations/*.sql\n---\nNever drop columns without owner approval.\n',
    '.harness/skills/db-migrations/SKILL.md': '---\nid: db-migrations\npartitions:\n  - db\ndescription: Generate and verify Drizzle SQL migrations.\n---\nRun drizzle-generate after updating schema.\n',
    '.harness/skills/ui-verification/instructions.md': 'Verify UI layouts in headless browser sandbox.\n',
    '.harness/skills/shared/tdd.md': '---\nid: shared-tdd\ndescription: Test-driven workflow.\n---\nRun verify-suite before stopping.\n',
    '.harness/prompts/base-posture.md': 'Follow repository architecture and rules.\n',
    '.harness/prompts/worker.md': 'Implement the assigned partition task.\n',
    '.harness/prompts/evaluator.md': 'Audit candidate diff against acceptance criteria.\n',
    '.harness/prompts/lease-adjudicator.md': 'Adjudicate existing test write lease requests.\n',
    '.harness/prompts/candidate-arbiter.md': 'Compare speculative candidate branches.\n',
    '.harness/prompts/coordinator.md': 'Coordinate multi-partition architecture and forks.\n',
    '.harness/prompts/lesson-distiller.md': 'Distill concise preventative lessons from recovery.\n',
    'node_modules/.keep': 'warm\n',
  };
  for (const [rel, text] of Object.entries(files)) await writeFile(path.join(repoDir, rel), text, 'utf8');
  const pnpmShim = `#!/usr/bin/env node\nconst fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process'), net = require('node:net'), readline = require('node:readline');\nconst args = process.argv.slice(2);\nif (args[0] === 'install') process.exit(0);\nif (args.includes('dev:headless')) {\n  const getPort = (flag) => Number(args[args.indexOf(flag) + 1]);\n  const s1 = net.createServer().listen(getPort('--port'), '127.0.0.1');\n  const s2 = net.createServer().listen(getPort('--remote-debugging-port'), '127.0.0.1');\n  Promise.all([new Promise((r) => s1.once('listening', r)), new Promise((r) => s2.once('listening', r))]).then(() => process.stdout.write('Ready in 12ms\\n'));\n  setInterval(() => {}, 60000);\n  return;\n}\nif (args[0] === 'tsx') {\n  const cdpPort = Number(args[2] || '0');\n  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });\n  process.stdout.write('cdp> ');\n  rl.on('line', (line) => process.stdout.write(JSON.stringify({ cdpPort, command: line.trim(), title: 'Acme Portal' }) + '\\ncdp> '));\n  return;\n}\nif (args[0] === 'test' || args[0] === 'verify') {\n  for (const pkg of ['db', 'api', 'web']) {\n    const tDir = path.join(process.cwd(), 'packages', pkg, 'test');\n    if (!fs.existsSync(tDir)) continue;\n    for (const f of fs.readdirSync(tDir).filter((n) => n.endsWith('.test.ts'))) {\n      const r = cp.spawnSync(process.execPath, ['--experimental-strip-types', path.join(tDir, f)], { cwd: process.cwd(), encoding: 'utf8' });\n      if (r.status !== 0) { process.stdout.write('FAIL packages/' + pkg + '/test/' + f + '\\n  ● ' + (r.stderr || r.stdout || 'Assertion failed') + '\\n'); process.exit(1); }\n    }\n  }\n  process.stdout.write('PASS all suites\\n'); process.exit(0);\n}\nprocess.exit(0);\n`;
  const ghShim = `#!/usr/bin/env node\nconst fs = require('node:fs');\nconst logPath = ${JSON.stringify(ghPrsLogPath)};\nconst args = process.argv.slice(2);\nconst prs = JSON.parse(fs.readFileSync(logPath, 'utf8'));\nif (args[0] === 'pr' && args[1] === 'view') {\n  const head = args[2];\n  const found = prs.some((p) => p.head === head && (p.state === 'OPEN' || p.state === 'MERGED'));\n  process.stdout.write(found ? 'true\\n' : 'false\\n');\n  process.exit(0);\n}\nif (args[0] === 'pr' && args[1] === 'create') {\n  const getOpt = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : ''; };\n  prs.push({ base: getOpt('--base'), head: getOpt('--head'), title: getOpt('--title'), body: getOpt('--body'), state: 'OPEN' });\n  fs.writeFileSync(logPath, JSON.stringify(prs, null, 2));\n  process.stdout.write('https://github.com/acme/app/pull/' + prs.length + '\\n');\n  process.exit(0);\n}\nprocess.exit(0);\n`;
  await writeFile(path.join(binDir, 'pnpm'), pnpmShim, { encoding: 'utf8', mode: 0o755 });
  await writeFile(path.join(binDir, 'gh'), ghShim, { encoding: 'utf8', mode: 0o755 });
  const gitCmds: ReadonlyArray<readonly string[]> = [
    ['init', '--bare', '--initial-branch=main', remoteBareDir], ['init', '--initial-branch=main', repoDir],
    ['config', 'user.name', 'Harness Test'], ['config', 'user.email', 'harness@acme.test'],
    ['remote', 'add', 'origin', remoteBareDir], ['add', '-A'],
    ['commit', '-m', 'Initial monorepo seed'], ['push', '-u', 'origin', 'main'],
  ];
  for (const args of gitCmds) execFileSync('git', args, { cwd: args[1] === '--bare' ? tempRootDir : repoDir, stdio: 'ignore' });
  const sqlitePath = path.join(repoDir, '.harness/state.sqlite');
  const db = openSqliteConnection(sqlitePath);
  try {
    db.exec("CREATE TABLE IF NOT EXISTS owner_global_rules (id TEXT PRIMARY KEY, directive TEXT NOT NULL); INSERT OR IGNORE INTO owner_global_rules (id, directive) VALUES ('owner-rule-1', 'Maintain backwards compatibility unless approved by owner.');");
  } finally {
    db.close();
  }
  const nextPath = `${binDir}${path.delimiter}${previousPath}`;
  process.env['PATH'] = nextPath;
  process.chdir(repoDir);
  let cleaned = false;
  return Object.freeze<IntegrationWorkspaceHandle>({
    tempRootDir, repoDir, remoteBareDir, sqlitePath, ghPrsLogPath,
    env: Object.freeze({ PATH: nextPath, ANTHROPIC_API_KEY: 'sk-ant-test', GITHUB_TOKEN: 'ghp-test', GH_WEBHOOK_SECRET: 'whsec-test', SLACK_APP_TOKEN: 'xapp-test', SLACK_BOT_TOKEN: 'xoxb-test', SLACK_CHANNEL_ID: 'C123' }),
    readCreatedPrs: async () => JSON.parse(await readFile(ghPrsLogPath, 'utf8')),
    cleanup: async () => {
      if (cleaned) return;
      cleaned = true;
      process.chdir(previousCwd);
      process.env['PATH'] = previousPath;
      await rm(tempRootDir, { recursive: true, force: true });
    },
  });
}
