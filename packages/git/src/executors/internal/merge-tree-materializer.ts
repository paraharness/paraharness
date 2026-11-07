import type { GitWorktreeHandle } from '@harness-dsl/core';
import {
  executeStatelessMergeTree as executeMergeTree,
  finalizeMaterializedMergeMetadata as finalizeMergeMetadata,
  gitWorktreeMaterializeMerge,
  synthesizeWorkingTreeCommitOverBase as synthesizeCommitOverBase,
} from './git-worktree-materialize-merge.js';
import type { MaterializeInFlightMergeParams } from './merge-tree-materializer-params.js';
import type { StatelessMergeTreeResult } from './stateless-merge-tree-result.js';
import type { SynthesizedWorkingTreeCommit } from './synthesized-working-tree-commit.js';

/**
 * Synthesizes a temporary Git tree and commit object over `parentCommitSha` without mutating `<gitdir>/index` or `HEAD`.
 *
 * Stages all dirty tracked and untracked files from `gitCheckpointStatusMap` into a temporary index file.
 *
 * @param {GitWorktreeHandle}             handle          - Worktree handle whose working state should be synthesized.
 * @param {string}                        parentCommitSha - Parent commit SHA (`-p`) for `git commit-tree`.
 * @param {readonly string[] | undefined} [excludeGlobs]  - Optional glob patterns excluded from staging.
 *
 * @returns {Promise<SynthesizedWorkingTreeCommit>} Synthesized tree SHA and commit SHA.
 */
export function synthesizeWorkingTreeCommitOverBase(
  handle: GitWorktreeHandle,
  parentCommitSha: string,
  excludeGlobs?: readonly string[],
): Promise<SynthesizedWorkingTreeCommit> {
  return synthesizeCommitOverBase(handle, parentCommitSha, excludeGlobs);
}

/**
 * Executes a stateless 3-way `git merge-tree --write-tree -z` between `targetCommitSha` and `sourceCommitSha` over `baseRef`.
 *
 * Synthesizes `targetPrime` with `baseRef` as its sole immediate parent so Git 2.38+ always uses `baseRef` as the merge base.
 *
 * @param {GitWorktreeHandle} handle          - Worktree handle providing `worktreePath` and `baseRef`.
 * @param {string}            targetCommitSha - Target commit SHA ($C_1$ or $C_{\text{prereq}}$).
 * @param {string}            sourceCommitSha - Source commit SHA ($C_{\text{child}}$ or $C_{\text{root}}$) parented on `handle.baseRef`.
 *
 * @returns {Promise<StatelessMergeTreeResult>} Merge tree result.
 */
export function executeStatelessMergeTree(
  handle: GitWorktreeHandle,
  targetCommitSha: string,
  sourceCommitSha: string,
): Promise<StatelessMergeTreeResult> {
  return executeMergeTree(handle, targetCommitSha, sourceCommitSha);
}

/**
 * Atomically materializes `inFlightMerge` into `handle`'s working tree and updates `HEAD`, `.git/index`, and `baseRef`.
 *
 * Persists `inFlightMerge` in `<gitdir>/harness-meta.json` before modifying files, checks out `mergedTreeSha`, unlinks removed paths, and records conflict digests.
 *
 * @param {GitWorktreeHandle}              handle      - Target worktree handle to materialize into.
 * @param {MaterializeInFlightMergeParams} mergeParams - Merge materialization parameters.
 *
 * @returns {Promise<Readonly<Record<string, string>>>} Frozen map of conflicted paths to their materialized `${mode}:${sha256}` digests.
 */
export function materializeInFlightMergeIntoWorktree(
  handle: GitWorktreeHandle,
  mergeParams: MaterializeInFlightMergeParams,
): Promise<Readonly<Record<string, string>>> {
  return gitWorktreeMaterializeMerge(handle, mergeParams);
}

/**
 * Completes `materializeInFlightMergeIntoWorktree` by updating `HEAD`, live `.git/index`, `baseRef`, and `unresolvedConflictPaths`.
 *
 * Computes post-checkout `${mode}:${sha256}` digests for `conflictedPaths` and clears `inFlightMerge` in `harness-meta.json`.
 *
 * @param {GitWorktreeHandle}              handle      - Target worktree handle.
 * @param {MaterializeInFlightMergeParams} mergeParams - Finalization parameters.
 *
 * @returns {Promise<Readonly<Record<string, string>>>} Frozen map of unresolved conflict paths to materialized digests.
 */
export function finalizeMaterializedMergeMetadata(
  handle: GitWorktreeHandle,
  mergeParams: MaterializeInFlightMergeParams,
): Promise<Readonly<Record<string, string>>> {
  return finalizeMergeMetadata(handle, mergeParams);
}
