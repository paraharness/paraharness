import { lstat, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { GitCowWorktreeNode, GitWorktreeHandle } from '@harness-dsl/core';
import {
  cloneNodeModulesTree,
  hydrateWorktreeDependencies,
} from './cow-worktree-hydrator.js';
import {
  readHarnessMeta,
  runGitCommand,
  writeHarnessMeta,
} from './git-cli-runner.js';
import { materializeInFlightMergeIntoWorktree } from './merge-tree-materializer.js';
import { restoreGitWorktreeCheckpoint } from './porcelain-v2-and-checkpoints.js';

/**
 * Completes or rolls back any interrupted atomic metadata state (`pendingParentHeadSha`, `inFlightMerge`, `inFlightCommitAndPush`).
 *
 * Preserves intact working-tree edits across process reboots when no in-flight atomic transition was interrupted.
 *
 * @param {string} worktreePath - Absolute path to the existing worktree directory on disk.
 *
 * @returns {Promise<GitWorktreeHandle>} Rebound and recovered `GitWorktreeHandle`.
 */
async function recoverInFlightWorktreeState(worktreePath: string): Promise<GitWorktreeHandle> {
  const rawGitDir = (await runGitCommand({ cwd: worktreePath, args: ['rev-parse', '--git-dir'] })).stdout.trim();
  const gitDirPath = path.resolve(worktreePath, rawGitDir);
  let meta = await readHarnessMeta(gitDirPath);
  if (meta.pendingParentHeadSha !== undefined) {
    await runGitCommand({ cwd: worktreePath, args: ['update-ref', 'HEAD', meta.pendingParentHeadSha] });
    meta = { ...meta, pendingParentHeadSha: undefined };
    await writeHarnessMeta(gitDirPath, meta);
  }
  if (meta.inFlightMerge !== undefined) {
    const m = meta.inFlightMerge;
    const tmpHandle: GitWorktreeHandle = { worktreePath, gitDirPath, baseRef: meta.baseRef, baseBranch: meta.baseBranch, branchName: meta.branchName, headRef: meta.baseRef, unresolvedConflictPaths: meta.unresolvedConflictPaths };
    await materializeInFlightMergeIntoWorktree(tmpHandle, { targetHeadSha: m.targetHeadSha, mergedTreeSha: m.mergedTreeSha, priorTreeSha: m.priorTreeSha, conflictedPaths: Object.keys(m.unresolvedConflictPaths) });
    meta = await readHarnessMeta(gitDirPath);
  }
  if (meta.inFlightCommitAndPush !== undefined) {
    const commitState = meta.inFlightCommitAndPush;
    await runGitCommand({ cwd: worktreePath, args: ['rebase', '--abort'], allowNonZeroExit: true });
    await runGitCommand({ cwd: worktreePath, args: ['reset', '--hard', commitState.preStepHeadSha] });
    meta = { ...meta, baseRef: commitState.preStepBaseRef, inFlightCommitAndPush: undefined };
    await writeHarnessMeta(gitDirPath, meta);
  }
  const headRef = (await runGitCommand({ cwd: worktreePath, args: ['rev-parse', 'HEAD'] })).stdout.trim();
  return {
    worktreePath,
    gitDirPath,
    baseRef: meta.baseRef,
    baseBranch: meta.baseBranch,
    branchName: meta.branchName,
    headRef,
    unresolvedConflictPaths: meta.unresolvedConflictPaths,
  };
}

/**
 * Rebinds an existing Task Root Worktree at `<dir>/roots/<runId>` or recreates it from `checkpoint` if missing.
 *
 * Completes interrupted `pendingParentHeadSha` or `inFlightMerge` transitions and rolls back `inFlightCommitAndPush`.
 *
 * @param {GitCowWorktreeNode} node         - Worktree scope AST node configuration.
 * @param {string}             runId        - Unique flow run identifier.
 * @param {string}             [checkpoint] - Optional serialized checkpoint fallback when the directory is missing.
 *
 * @returns {Promise<GitWorktreeHandle>} Reattached root `GitWorktreeHandle`.
 */
export async function reattachRootWorktree(
  node: GitCowWorktreeNode,
  runId: string,
  checkpoint?: string,
): Promise<GitWorktreeHandle> {
  const repoPath = path.resolve(node.repo);
  const baseDir = path.isAbsolute(node.dir) ? node.dir : path.resolve(repoPath, node.dir);
  const safeRunId = runId.replace(/[^a-zA-Z0-9._-]/g, '_');
  const worktreePath = path.join(baseDir, 'roots', safeRunId);
  const exists = await lstat(worktreePath).then(() => true, () => false);
  if (exists) return recoverInFlightWorktreeState(worktreePath);
  await runGitCommand({ cwd: repoPath, args: ['worktree', 'prune'], allowNonZeroExit: true });
  await mkdir(path.dirname(worktreePath), { recursive: true });
  const pinnedRes = await runGitCommand({ cwd: repoPath, args: ['rev-parse', '--verify', `refs/harness/completed/roots/${safeRunId}`], allowNonZeroExit: true });
  const baseRef = pinnedRes.exitCode === 0 && pinnedRes.stdout.trim().length > 0
    ? pinnedRes.stdout.trim()
    : (await runGitCommand({ cwd: repoPath, args: ['rev-parse', 'HEAD'] })).stdout.trim();
  await runGitCommand({ cwd: repoPath, args: ['worktree', 'add', '--detach', '--force', worktreePath, baseRef] });
  const rawGitDir = (await runGitCommand({ cwd: worktreePath, args: ['rev-parse', '--git-dir'] })).stdout.trim();
  const gitDirPath = path.resolve(worktreePath, rawGitDir);
  await hydrateWorktreeDependencies(node, repoPath, worktreePath);
  const emptyConflicts: Readonly<Record<string, string>> = Object.freeze({});
  await writeHarnessMeta(gitDirPath, { baseRef, baseBranch: 'main', unresolvedConflictPaths: emptyConflicts });
  const handle: GitWorktreeHandle = { worktreePath, gitDirPath, baseRef, baseBranch: 'main', headRef: baseRef, unresolvedConflictPaths: emptyConflicts };
  if (checkpoint !== undefined) await restoreGitWorktreeCheckpoint(handle, checkpoint);
  return handle;
}

/**
 * Rebinds an existing child fork worktree at `<dir>/forks/<runId>/<forkId>` or recreates it from `checkpoint` if missing.
 *
 * Completes any interrupted `inFlightMerge` materialization and preserves uncommitted child edits across reboots.
 *
 * @param {GitWorktreeHandle} parent       - Reattached parent worktree handle.
 * @param {string}            forkId       - Unique child fork or branch identifier.
 * @param {string}            [checkpoint] - Optional serialized checkpoint fallback when the directory is missing.
 *
 * @returns {Promise<GitWorktreeHandle>} Reattached child `GitWorktreeHandle`.
 */
export async function reattachChildWorktree(
  parent: GitWorktreeHandle,
  forkId: string,
  checkpoint?: string,
): Promise<GitWorktreeHandle> {
  const parentDir = path.dirname(parent.worktreePath);
  const isParentRoot = path.basename(parentDir) === 'roots';
  const runId = isParentRoot ? path.basename(parent.worktreePath) : path.basename(parentDir);
  const baseDir = isParentRoot ? path.dirname(parentDir) : path.dirname(path.dirname(parentDir));
  const safeForkId = forkId.replace(/[^a-zA-Z0-9._-]/g, '_');
  const worktreePath = path.join(baseDir, 'forks', runId, safeForkId);
  const exists = await lstat(worktreePath).then(() => true, () => false);
  if (exists) return recoverInFlightWorktreeState(worktreePath);
  await runGitCommand({ cwd: parent.worktreePath, args: ['worktree', 'prune'], allowNonZeroExit: true });
  await mkdir(path.dirname(worktreePath), { recursive: true });
  const pinnedRes = await runGitCommand({ cwd: parent.worktreePath, args: ['rev-parse', '--verify', `refs/harness/completed/forks/${runId}/${safeForkId}`], allowNonZeroExit: true });
  const baseRef = pinnedRes.exitCode === 0 && pinnedRes.stdout.trim().length > 0
    ? pinnedRes.stdout.trim()
    : (parent.headRef ?? parent.baseRef);
  await runGitCommand({ cwd: parent.worktreePath, args: ['worktree', 'add', '--detach', '--force', worktreePath, baseRef] });
  const rawGitDir = (await runGitCommand({ cwd: worktreePath, args: ['rev-parse', '--git-dir'] })).stdout.trim();
  const gitDirPath = path.resolve(worktreePath, rawGitDir);
  await cloneNodeModulesTree(parent.worktreePath, worktreePath);
  const emptyConflicts: Readonly<Record<string, string>> = Object.freeze({});
  await writeHarnessMeta(gitDirPath, { baseRef, baseBranch: parent.baseBranch, branchName: parent.branchName, unresolvedConflictPaths: emptyConflicts });
  const handle: GitWorktreeHandle = { worktreePath, gitDirPath, baseRef, baseBranch: parent.baseBranch, branchName: parent.branchName, headRef: baseRef, unresolvedConflictPaths: emptyConflicts };
  if (checkpoint !== undefined) await restoreGitWorktreeCheckpoint(handle, checkpoint);
  return handle;
}
