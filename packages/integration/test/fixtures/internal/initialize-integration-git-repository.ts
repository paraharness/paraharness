import { execFileSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';

/**
 * Initializes the bare `origin` remote and working `repoDir` Git repository, commits the seeded files, and pushes `main`.
 *
 * Configures local commit identity (`Harness Test <harness@acme.test>`) so subsequent CoW worktree
 * commits and rebases succeed in isolated test environments.
 *
 * @param {string} tempRootDir   - Parent temporary directory containing `repoDir` and `remoteBareDir`.
 * @param {string} repoDir       - Working Git monorepo directory path.
 * @param {string} remoteBareDir - Bare Git remote directory path registered as `origin`.
 *
 * @returns {Promise<void>} Resolves once `origin/main` is initialized and pushed.
 */
export async function initializeIntegrationGitRepository(
  tempRootDir: string,
  repoDir: string,
  remoteBareDir: string,
): Promise<void> {
  await mkdir(remoteBareDir, { recursive: true });
  const gitCommands: ReadonlyArray<readonly string[]> = [
    ['init', '--bare', '--initial-branch=main', remoteBareDir],
    ['init', '--initial-branch=main', repoDir],
    ['config', 'user.name', 'Harness Test'],
    ['config', 'user.email', 'harness@acme.test'],
    ['remote', 'add', 'origin', remoteBareDir],
    ['add', '-A'],
    ['commit', '-m', 'Initial monorepo seed'],
    ['push', '-u', 'origin', 'main'],
  ];
  for (const args of gitCommands) {
    const cwd = args[1] === '--bare' ? tempRootDir : repoDir;
    execFileSync('git', args, { cwd, stdio: 'ignore' });
  }
}
