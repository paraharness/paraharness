import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import type { GitCowWorktreeNode, GitWorktreeHandle } from '@harness-dsl/core';
import { cloneNodeModulesTree } from './cow-worktree-hydrator.js';
import { copyFileCowOrValue } from './file-digest-and-globs.js';
import {
  readHarnessMeta,
  runGitCommand,
  writeHarnessMeta,
} from './git-cli-runner.js';
import { synthesizeWorkingTreeCommitOverBase } from './git-worktree-materialize-merge.js';

/**
 * Copies any unresolved conflict files from `parentWorktreePath` into `childWorktreePath`.
 *
 * Unlinks paths recorded as `'MISSING'` and returns a frozen copy of the unresolved conflict map.
 *
 * @param {string}                           parentWorktreePath      - Source parent worktree directory path.
 * @param {string}                           childWorktreePath       - Destination child worktree directory path.
 * @param {Readonly<Record<string, string>>} unresolvedConflictPaths - Map of conflicted paths to digests on the parent.
 *
 * @returns {Promise<Readonly<Record<string, string>>>} Frozen unresolved conflict digest map for the child worktree.
 */
export async function copyParentUnresolvedConflictsToChild(
  parentWorktreePath: string,
  childWorktreePath: string,
  unresolvedConflictPaths: Readonly<Record<string, string>>,
): Promise<Readonly<Record<string, string>>> {
  const copiedConflicts: Record<string, string> = {
    ...unresolvedConflictPaths,
  };
  for (const [relPath, digest] of Object.entries(copiedConflicts)) {
    const childTargetPath = path.join(childWorktreePath, relPath);
    if (digest === 'MISSING') {
      await rm(childTargetPath, { force: true });
    } else {
      await copyFileCowOrValue(
        path.join(parentWorktreePath, relPath),
        childTargetPath,
      );
    }
  }
  return Object.freeze(copiedConflicts);
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
export async function gitWorktreeForkChild(
  node: GitCowWorktreeNode,
  parent: GitWorktreeHandle,
  forkId: string,
): Promise<GitWorktreeHandle> {
  const repoPath = path.resolve(node.repo);
  const baseDir = path.isAbsolute(node.dir)
    ? node.dir
    : path.resolve(repoPath, node.dir);
  const parentDirName = path.basename(path.dirname(parent.worktreePath));
  const runId =
    parentDirName === 'roots'
      ? path.basename(parent.worktreePath)
      : parentDirName;
  const safeForkId = forkId.replace(/[^a-zA-Z0-9._-]/g, '_');
  const worktreePath = path.join(baseDir, 'forks', runId, safeForkId);
  await rm(worktreePath, { recursive: true, force: true });
  await runGitCommand({
    cwd: parent.worktreePath,
    args: ['worktree', 'prune'],
    allowNonZeroExit: true,
  });
  await mkdir(path.dirname(worktreePath), { recursive: true });
  const parentHeadResult = await runGitCommand({
    cwd: parent.worktreePath,
    args: ['rev-parse', 'HEAD'],
  });
  const parentHeadSha = parentHeadResult.stdout.trim();
  const parentMeta = await readHarnessMeta(parent.gitDirPath);
  await runGitCommand({
    cwd: parent.worktreePath,
    args: [
      'worktree',
      'add',
      '--detach',
      '--force',
      worktreePath,
      parentHeadSha,
    ],
  });
  const gitDirResult = await runGitCommand({
    cwd: worktreePath,
    args: ['rev-parse', '--git-dir'],
  });
  const gitDirPath = path.resolve(worktreePath, gitDirResult.stdout.trim());
  await cloneNodeModulesTree(
    parent.worktreePath,
    worktreePath,
    node.excludeFromCloneGlobs,
  );
  const frozenConflicts = await copyParentUnresolvedConflictsToChild(
    parent.worktreePath,
    worktreePath,
    parentMeta.unresolvedConflictPaths,
  );
  await writeHarnessMeta(gitDirPath, {
    baseRef: parentHeadSha,
    baseBranch: parent.baseBranch,
    branchName: parent.branchName,
    unresolvedConflictPaths: frozenConflicts,
  });
  return {
    worktreePath,
    gitDirPath,
    baseRef: parentHeadSha,
    baseBranch: parent.baseBranch,
    branchName: parent.branchName,
    headRef: parentHeadSha,
    unresolvedConflictPaths: frozenConflicts,
  };
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
export async function gitWorktreeReleaseAndPinRef(
  handle: GitWorktreeHandle,
  excludeGlobs?: readonly string[],
): Promise<void> {
  const synth = await synthesizeWorkingTreeCommitOverBase(
    handle,
    handle.baseRef,
    excludeGlobs,
  );
  const parentDir = path.dirname(handle.worktreePath);
  const isRoot = path.basename(parentDir) === 'roots';
  const completedRef = isRoot
    ? `refs/harness/completed/roots/${path.basename(handle.worktreePath)}`
    : `refs/harness/completed/forks/${path.basename(parentDir)}/${path.basename(handle.worktreePath)}`;
  await runGitCommand({
    cwd: handle.worktreePath,
    args: ['update-ref', completedRef, synth.commitSha],
  });
  const commonDirResult = await runGitCommand({
    cwd: handle.worktreePath,
    args: ['rev-parse', '--git-common-dir'],
  });
  const commonGitDir = path.resolve(
    handle.worktreePath,
    commonDirResult.stdout.trim(),
  );
  await rm(path.join(handle.gitDirPath, 'harness-ckpt-blobs'), {
    recursive: true,
    force: true,
  });
  await rm(path.join(handle.gitDirPath, 'harness-ckpt-nm'), {
    recursive: true,
    force: true,
  });
  await runGitCommand({
    cwd: commonGitDir,
    args: [
      '--git-dir',
      commonGitDir,
      'worktree',
      'remove',
      '--force',
      handle.worktreePath,
    ],
    allowNonZeroExit: true,
  });
  await rm(handle.worktreePath, { recursive: true, force: true });
  await runGitCommand({
    cwd: commonGitDir,
    args: ['--git-dir', commonGitDir, 'worktree', 'prune'],
    allowNonZeroExit: true,
  });
}
