import type { GitCowWorktreeNode, GitWorktreeHandle } from '@harness-dsl/core';
import {
  gitWorktreeReattachChild,
  gitWorktreeReattachRoot,
  resolveEffectiveCheckpointPolicy as resolveEffectivePolicy,
} from './git-worktree-reattach.js';

/**
 * Merges `node.excludeFromCloneGlobs` and `node.checkpointPolicy?.excludeGlobs` into an effective checkpoint policy.
 *
 * Precomputes the combined exclusion globs so checkpoint serialization, diffing, and restoration share one policy.
 *
 * @param {GitCowWorktreeNode} node - Passive worktree scope AST configuration node.
 *
 * @returns {GitCowWorktreeNode['checkpointPolicy']} Effective checkpoint policy with merged `excludeGlobs`.
 */
export function resolveEffectiveCheckpointPolicy(
  node: GitCowWorktreeNode,
): GitCowWorktreeNode['checkpointPolicy'] {
  return resolveEffectivePolicy(node);
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
export function reattachRootWorktree(
  node: GitCowWorktreeNode,
  runId: string,
  checkpoint?: string,
): Promise<GitWorktreeHandle> {
  return gitWorktreeReattachRoot(node, runId, checkpoint);
}

/**
 * Rebinds an existing child fork worktree at `<dir>/forks/<runId>/<forkId>` or recreates it from `checkpoint` if missing.
 *
 * Completes any interrupted `inFlightMerge` materialization and preserves uncommitted child edits across reboots.
 *
 * @param {GitCowWorktreeNode} node         - Worktree scope AST node configuration.
 * @param {GitWorktreeHandle}  parent       - Reattached parent worktree handle.
 * @param {string}             forkId       - Unique child fork or branch identifier.
 * @param {string}             [checkpoint] - Optional serialized checkpoint fallback when the directory is missing.
 *
 * @returns {Promise<GitWorktreeHandle>} Reattached child `GitWorktreeHandle`.
 */
export function reattachChildWorktree(
  node: GitCowWorktreeNode,
  parent: GitWorktreeHandle,
  forkId: string,
  checkpoint?: string,
): Promise<GitWorktreeHandle> {
  return gitWorktreeReattachChild(node, parent, forkId, checkpoint);
}
