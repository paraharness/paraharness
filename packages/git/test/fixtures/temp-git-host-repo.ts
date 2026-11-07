import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runGitCommand } from '../../src/executors/internal/git-cli-runner.js';
import type {
  TempGitCommitOptions,
  TempGitHostRepoHandle,
} from './temp-git-host-repo-handle.js';

/**
 * Creates a real local Git repository (`main` branch) paired with a local bare `origin` remote.
 *
 * Seeds initial multi-partition files (`src/index.ts`, `src/internal/helper.ts`, `pnpm-lock.yaml`, and `.gitignore`),
 * pushes `main` to `origin`, and returns a `TempGitHostRepoHandle` for deterministic test suites.
 *
 * @param {Readonly<Record<string, string>>} [initialFiles] - Optional additional files included in the initial commit.
 *
 * @returns {Promise<TempGitHostRepoHandle>} Initialized temporary Git host and bare origin repository handle.
 */
export async function createTempGitHostRepo(
  initialFiles?: Readonly<Record<string, string>>,
): Promise<TempGitHostRepoHandle> {
  const rootTmpDir = await mkdtemp(path.join(tmpdir(), 'harness-git-test-'));
  const originPath = path.join(rootTmpDir, 'origin.git');
  const repoPath = path.join(rootTmpDir, 'host');
  const worktreesDir = path.join(rootTmpDir, 'worktrees');
  await mkdir(originPath, { recursive: true });
  await mkdir(repoPath, { recursive: true });
  await mkdir(worktreesDir, { recursive: true });
  await runGitCommand({ cwd: originPath, args: ['init', '--bare', '--initial-branch=main'] });
  await runGitCommand({ cwd: repoPath, args: ['init', '--initial-branch=main'] });
  await runGitCommand({ cwd: repoPath, args: ['remote', 'add', 'origin', originPath] });

  const defaultSeed: Record<string, string> = {
    '.gitignore': 'dist/\n*.log\n',
    'pnpm-lock.yaml': 'lockfileVersion: 9.0\npackages: {}\n',
    'src/index.ts': 'export function add(a: number, b: number): number {\n  return a + b;\n}\n',
    'src/internal/helper.ts': 'export const BASE_OFFSET = 10;\n',
    'README.md': '# Sample Repo\n',
    ...(initialFiles ?? {}),
  };

  const commitFiles = async (
    files: Readonly<Record<string, string>>,
    message: string,
    options?: TempGitCommitOptions,
  ): Promise<string> => {
    for (const [relPath, content] of Object.entries(files)) {
      const absPath = path.join(repoPath, relPath);
      await mkdir(path.dirname(absPath), { recursive: true });
      await writeFile(absPath, content, 'utf8');
    }
    await runGitCommand({ cwd: repoPath, args: ['add', '-A'] });
    await runGitCommand({ cwd: repoPath, args: ['commit', '-m', message] });
    const sha = (await runGitCommand({ cwd: repoPath, args: ['rev-parse', 'HEAD'] })).stdout.trim();
    if (options?.pushOrigin) {
      const branch = (await runGitCommand({ cwd: repoPath, args: ['symbolic-ref', '--short', 'HEAD'] })).stdout.trim();
      await runGitCommand({ cwd: repoPath, args: ['push', '-u', 'origin', `${branch}:refs/heads/${branch}`] });
      await runGitCommand({ cwd: repoPath, args: ['fetch', 'origin'] });
    }
    return sha;
  };

  const initialCommitSha = await commitFiles(defaultSeed, 'chore: initial commit', { pushOrigin: true });

  return Object.freeze<TempGitHostRepoHandle>({
    rootTmpDir,
    repoPath,
    hostRepoPath: repoPath,
    originPath,
    remoteRepoPath: originPath,
    worktreesDir,
    initialCommitSha,
    baseSha: initialCommitSha,
    commitFiles,
    cleanup: async (): Promise<void> => {
      await rm(rootTmpDir, { recursive: true, force: true });
    },
  });
}
