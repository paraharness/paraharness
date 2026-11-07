import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import type { GitCowWorktreeNode, GitWorktreeHandle } from '@harness-dsl/core';
import { hydrateWorktreeDependencies } from './cow-worktree-hydrator.js';
import {
  runGitCommand,
  withHostWorktreeLock,
  writeHarnessMeta,
} from './git-cli-runner.js';
import type { HostRepositoryHeadState } from './host-repository-head-state.js';

/**
 * Resolves `baseRef` (`HEAD` commit SHA) and `baseBranch` (`symbolic-ref --short HEAD` or `'main'`) from `repoPath`.
 *
 * @param {string} repoPath - Absolute path to the host Git repository.
 *
 * @returns {Promise<HostRepositoryHeadState>} Resolved `baseRef` and `baseBranch`.
 */
export async function resolveHostRepositoryHeadState(
  repoPath: string,
): Promise<HostRepositoryHeadState> {
  const baseRef = (await runGitCommand({ cwd: repoPath, args: ['rev-parse', 'HEAD'] })).stdout.trim();
  const branchOutput = await runGitCommand({
    cwd: repoPath,
    args: ['symbolic-ref', '--short', 'HEAD'],
    allowNonZeroExit: true,
  });
  const trimmedBranch = branchOutput.stdout.trim();
  const baseBranch = branchOutput.exitCode === 0 && trimmedBranch.length > 0 ? trimmedBranch : 'main';
  return { baseRef, baseBranch };
}

/**
 * Provisions an isolated Task Root Worktree at `<dir>/roots/<runId>` via `git worktree add --detach`.
 *
 * Hydrates `node_modules` (honoring `.lockfileGate` and `.setup`) and initializes `<gitdir>/harness-meta.json`.
 *
 * @param {GitCowWorktreeNode} node  - Worktree scope AST node configuration.
 * @param {string}             runId - Unique flow run identifier.
 *
 * @returns {Promise<GitWorktreeHandle>} Newly provisioned root `GitWorktreeHandle`.
 */
export async function gitWorktreeAcquireRoot(
  node: GitCowWorktreeNode,
  runId: string,
): Promise<GitWorktreeHandle> {
  const repoPath = path.resolve(node.repo);
  const baseDir = path.isAbsolute(node.dir) ? node.dir : path.resolve(repoPath, node.dir);
  const safeRunId = runId.replace(/[^a-zA-Z0-9._-]/g, '_');
  const worktreePath = path.join(baseDir, 'roots', safeRunId);
  await rm(worktreePath, { recursive: true, force: true });
  await mkdir(path.dirname(worktreePath), { recursive: true });
  const { baseRef, baseBranch } = await withHostWorktreeLock(
    repoPath,
    async (): Promise<HostRepositoryHeadState> => {
      await runGitCommand({
        cwd: repoPath,
        args: ['worktree', 'prune'],
        allowNonZeroExit: true,
      });
      const headState = await resolveHostRepositoryHeadState(repoPath);
      await runGitCommand({
        cwd: repoPath,
        args: ['worktree', 'add', '--detach', '--force', worktreePath, headState.baseRef],
      });
      return headState;
    },
  );
  const rawGitDir = (await runGitCommand({ cwd: worktreePath, args: ['rev-parse', '--git-dir'] })).stdout.trim();
  const gitDirPath = path.resolve(worktreePath, rawGitDir);
  await hydrateWorktreeDependencies(node, repoPath, worktreePath);
  const emptyConflicts: Readonly<Record<string, string>> = Object.freeze({});
  await writeHarnessMeta(gitDirPath, { baseRef, baseBranch, unresolvedConflictPaths: emptyConflicts });
  return {
    worktreePath,
    gitDirPath,
    baseRef,
    baseBranch,
    headRef: baseRef,
    unresolvedConflictPaths: emptyConflicts,
  };
}
