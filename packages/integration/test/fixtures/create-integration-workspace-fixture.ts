import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { IntegrationWorkspaceHandle } from './integration-workspace-handle.js';
import { initializeIntegrationGitRepository } from './internal/initialize-integration-git-repository.js';
import { seedIntegrationMonorepoFiles } from './internal/seed-integration-monorepo-files.js';
import { seedIntegrationSqliteStore } from './internal/seed-integration-sqlite-store.js';
import { writeIntegrationCliShims } from './internal/write-integration-cli-shims.js';

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
  const sqlitePath = path.join(repoDir, '.harness/state.sqlite');

  await seedIntegrationMonorepoFiles(repoDir);
  await writeIntegrationCliShims(binDir, ghPrsLogPath);
  await initializeIntegrationGitRepository(tempRootDir, repoDir, remoteBareDir);
  seedIntegrationSqliteStore(sqlitePath);

  const nextPath = `${binDir}${path.delimiter}${previousPath}`;
  process.env['PATH'] = nextPath;
  process.chdir(repoDir);
  let cleaned = false;

  return Object.freeze<IntegrationWorkspaceHandle>({
    tempRootDir,
    repoDir,
    remoteBareDir,
    sqlitePath,
    ghPrsLogPath,
    env: Object.freeze({
      PATH: nextPath,
      ANTHROPIC_API_KEY: 'sk-ant-test',
      GITHUB_TOKEN: 'ghp-test',
      GH_WEBHOOK_SECRET: 'whsec-test',
      SLACK_APP_TOKEN: 'xapp-test',
      SLACK_BOT_TOKEN: 'xoxb-test',
      SLACK_CHANNEL_ID: 'C123',
    }),
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
