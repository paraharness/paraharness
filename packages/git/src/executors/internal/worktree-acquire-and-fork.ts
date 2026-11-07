import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import type { GitCowWorktreeNode, GitWorktreeHandle } from '@harness-dsl/core';
import {
  cloneNodeModulesTree,
  hydrateWorktreeDependencies,
} from './cow-worktree-hydrator.js';
import { copyFileCowOrValue } from './file-digest-and-globs.js';
import {
  readHarnessMeta,
  runGitCommand,
  writeHarnessMeta,
} from './git-cli-runner.js';
import { synthesizeWorkingTreeCommitOverBase } from './merge-tree-materializer.js';

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
export async function acquireRootWorktree(
  node: GitCowWorktreeNode,
  runId: string,
): Promise<GitWorktreeHandle> {
  const repoPath = path.resolve(node.repo);
  const baseDir = path.isAbsolute(node.dir) ? node.dir : path.resolve(repoPath, node.dir);
  const safeRunId = runId.replace(/[^a-zA-Z0-9._-]/g, '_');
  const worktreePath = path.join(baseDir, 'roots', safeRunId);
  await rm(worktreePath, { recursive: true, force: true });
  await runGitCommand({ cwd: repoPath, args: ['worktree', 'prune'], allowNonZeroExit: true });
  await mkdir(path.dirname(worktreePath), { recursive: true });
  const baseRef = (await runGitCommand({ cwd: repoPath, args: ['rev-parse', 'HEAD'] })).stdout.trim();
  const branchRes = await runGitCommand({ cwd: repoPath, args: ['symbolic-ref', '--short', 'HEAD'], allowNonZeroExit: true });
  const baseBranch = branchRes.exitCode === 0 && branchRes.stdout.trim().length > 0 ? branchRes.stdout.trim() : 'main';
  await runGitCommand({ cwd: repoPath, args: ['worktree', 'add', '--detach', '--force', worktreePath, baseRef] });
  const rawGitDir = (await runGitCommand({ cwd: worktreePath, args: ['rev-parse', '--git-dir'] })).stdout.trim();
  const gitDirPath = path.resolve(worktreePath, rawGitDir);
  await hydrateWorktreeDependencies(node, repoPath, worktreePath);
  const emptyConflicts: Readonly<Record<string, string>> = Object.freeze({});
  await writeHarnessMeta(gitDirPath, { baseRef, baseBranch, unresolvedConflictPaths: emptyConflicts });
  return { worktreePath, gitDirPath, baseRef, baseBranch, headRef: baseRef, unresolvedConflictPaths: emptyConflicts };
}

/**
 * Forks an isolated child worktree at `<dir>/forks/<runId>/<forkId>` from an already-flushed `parent` handle.
 *
 * Clones `node_modules` and copies any `unresolvedConflictPaths` from `parent` into the child worktree.
 *
 * @param {GitCowWorktreeNode} node   - Worktree scope AST node configuration.
 * @param {GitWorktreeHandle}  parent - Flushed parent worktree handle.
 * @param {string}             forkId - Unique fork or speculative branch identifier.
 *
 * @returns {Promise<GitWorktreeHandle>} Newly provisioned child `GitWorktreeHandle`.
 */
export async function forkChildWorktree(
  node: GitCowWorktreeNode,
  parent: GitWorktreeHandle,
  forkId: string,
): Promise<GitWorktreeHandle> {
  const repoPath = path.resolve(node.repo);
  const baseDir = path.isAbsolute(node.dir) ? node.dir : path.resolve(repoPath, node.dir);
  const parentDirName = path.basename(path.dirname(parent.worktreePath));
  const runId = parentDirName === 'roots' ? path.basename(parent.worktreePath) : parentDirName;
  const safeForkId = forkId.replace(/[^a-zA-Z0-9._-]/g, '_');
  const worktreePath = path.join(baseDir, 'forks', runId, safeForkId);
  await rm(worktreePath, { recursive: true, force: true });
  await runGitCommand({ cwd: parent.worktreePath, args: ['worktree', 'prune'], allowNonZeroExit: true });
  await mkdir(path.dirname(worktreePath), { recursive: true });
  const parentHeadSha = (await runGitCommand({ cwd: parent.worktreePath, args: ['rev-parse', 'HEAD'] })).stdout.trim();
  const parentMeta = await readHarnessMeta(parent.gitDirPath);
  await runGitCommand({ cwd: parent.worktreePath, args: ['worktree', 'add', '--detach', '--force', worktreePath, parentHeadSha] });
  const rawGitDir = (await runGitCommand({ cwd: worktreePath, args: ['rev-parse', '--git-dir'] })).stdout.trim();
  const gitDirPath = path.resolve(worktreePath, rawGitDir);
  await cloneNodeModulesTree(parent.worktreePath, worktreePath, node.excludeFromCloneGlobs);
  const copiedConflicts: Record<string, string> = { ...parentMeta.unresolvedConflictPaths };
  for (const [relPath, digest] of Object.entries(copiedConflicts)) {
    if (digest === 'MISSING') await rm(path.join(worktreePath, relPath), { force: true });
    else await copyFileCowOrValue(path.join(parent.worktreePath, relPath), path.join(worktreePath, relPath));
  }
  const frozenConflicts = Object.freeze(copiedConflicts);
  await writeHarnessMeta(gitDirPath, { baseRef: parentHeadSha, baseBranch: parent.baseBranch, branchName: parent.branchName, unresolvedConflictPaths: frozenConflicts });
  return { worktreePath, gitDirPath, baseRef: parentHeadSha, baseBranch: parent.baseBranch, branchName: parent.branchName, headRef: parentHeadSha, unresolvedConflictPaths: frozenConflicts };
}

/**
 * Pins the terminal worktree state under `refs/harness/completed/{roots,forks}/...` and removes the worktree directory.
 *
 * Cleans up `<gitdir>/harness-ckpt-blobs/` and `<gitdir>/harness-ckpt-nm/` before running `git worktree remove --force`.
 *
 * @param {GitWorktreeHandle}             handle         - Root or child worktree handle to release.
 * @param {readonly string[] | undefined} [excludeGlobs] - Optional glob patterns excluded when synthesizing the final commit.
 *
 * @returns {Promise<void>} Resolves once the completed ref is pinned and the worktree is removed.
 */
export async function releaseWorktreeAndPinRef(
  handle: GitWorktreeHandle,
  excludeGlobs?: readonly string[],
): Promise<void> {
  const synth = await synthesizeWorkingTreeCommitOverBase(handle, handle.baseRef, excludeGlobs);
  const parentDir = path.dirname(handle.worktreePath);
  const isRoot = path.basename(parentDir) === 'roots';
  const completedRef = isRoot
    ? `refs/harness/completed/roots/${path.basename(handle.worktreePath)}`
    : `refs/harness/completed/forks/${path.basename(parentDir)}/${path.basename(handle.worktreePath)}`;
  await runGitCommand({ cwd: handle.worktreePath, args: ['update-ref', completedRef, synth.commitSha] });
  const commonDirRaw = (await runGitCommand({ cwd: handle.worktreePath, args: ['rev-parse', '--git-common-dir'] })).stdout.trim();
  const commonGitDir = path.resolve(handle.worktreePath, commonDirRaw);
  await rm(path.join(handle.gitDirPath, 'harness-ckpt-blobs'), { recursive: true, force: true });
  await rm(path.join(handle.gitDirPath, 'harness-ckpt-nm'), { recursive: true, force: true });
  await runGitCommand({ cwd: commonGitDir, args: ['--git-dir', commonGitDir, 'worktree', 'remove', '--force', handle.worktreePath], allowNonZeroExit: true });
  await rm(handle.worktreePath, { recursive: true, force: true });
  await runGitCommand({ cwd: commonGitDir, args: ['--git-dir', commonGitDir, 'worktree', 'prune'], allowNonZeroExit: true });
}
