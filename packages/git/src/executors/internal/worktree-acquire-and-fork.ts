import type { GitCowWorktreeNode, GitWorktreeHandle } from '@harness-dsl/core';
import { gitWorktreeAcquireRoot } from './git-worktree-acquire-root.js';
import {
  gitWorktreeForkChild,
  gitWorktreeReleaseAndPinRef,
} from './git-worktree-fork-and-release.js';

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
export function acquireRootWorktree(
  node: GitCowWorktreeNode,
  runId: string,
): Promise<GitWorktreeHandle> {
  return gitWorktreeAcquireRoot(node, runId);
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
export function forkChildWorktree(
  node: GitCowWorktreeNode,
  parent: GitWorktreeHandle,
  forkId: string,
): Promise<GitWorktreeHandle> {
  return gitWorktreeForkChild(node, parent, forkId);
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
export function releaseWorktreeAndPinRef(
  handle: GitWorktreeHandle,
  excludeGlobs?: readonly string[],
): Promise<void> {
  return gitWorktreeReleaseAndPinRef(handle, excludeGlobs);
}
