import type {
  GitScopeReceipt,
  GitSyncReceipt,
  GitWorktreeHandle,
  ReconcileResult,
} from '@metaharness/core';
import { GitSyncReceiptSchema } from '../../schemas/git-receipts.schema.js';
import { runGitCommand } from './git-cli-runner.js';
import { gitWorktreeFlushCleanParentChanges } from './git-worktree-flush-and-prune.js';
import {
  executeStatelessMergeTree,
  gitWorktreeMaterializeMerge,
  synthesizeWorkingTreeCommitOverBase,
} from './git-worktree-materialize-merge.js';
import { resolvePrerequisiteBaseBranch } from './parent-fast-forward.js';

/**
 * Rebases/merges uncommitted changes in `pausedChild` onto an updated `parent` worktree via `git merge-tree --write-tree`.
 *
 * Preserves dirty edits in `pausedChild` and records any conflicted paths in `pausedChild.unresolvedConflictPaths`.
 *
 * @param {GitWorktreeHandle}             parent         - Updated parent worktree handle.
 * @param {GitWorktreeHandle}             pausedChild    - Suspended child worktree handle being synced.
 * @param {readonly string[] | undefined} [excludeGlobs] - Optional glob patterns excluded from staging.
 *
 * @returns {Promise<ReconcileResult<GitSyncReceipt>>} Clean or conflicted synchronization receipt.
 */
export async function gitWorktreeSyncChild(
  parent: GitWorktreeHandle,
  pausedChild: GitWorktreeHandle,
  excludeGlobs?: readonly string[],
): Promise<ReconcileResult<GitSyncReceipt>> {
  const c0Sha = pausedChild.baseRef;
  const c1Sha = await gitWorktreeFlushCleanParentChanges(parent, excludeGlobs);
  const childSynth = await synthesizeWorkingTreeCommitOverBase(pausedChild, c0Sha, excludeGlobs);
  const mergeOutcome = await executeStatelessMergeTree(pausedChild, c1Sha, childSynth.commitSha);
  await gitWorktreeMaterializeMerge(pausedChild, {
    targetHeadSha: c1Sha,
    mergedTreeSha: mergeOutcome.mergedTreeSha,
    priorTreeSha: childSynth.treeSha,
    conflictedPaths: mergeOutcome.conflictedPaths,
    nextBaseBranch: parent.baseBranch,
  });
  const diffOutput = await runGitCommand({ cwd: pausedChild.worktreePath, args: ['diff-tree', '-r', '--name-only', '-z', c0Sha, c1Sha] });
  const updatedFiles = diffOutput.stdout.split('\0').filter((relPath) => relPath.length > 0);
  const receipt = GitSyncReceiptSchema.parse({ rebasedOntoRef: c1Sha, baseBranch: parent.baseBranch, updatedFiles });
  if (mergeOutcome.clean) return { status: 'clean', data: receipt };
  return {
    status: 'conflict',
    conflictedSummary: `syncChild conflict on paths: ${mergeOutcome.conflictedPaths.join(', ')}`,
    data: receipt,
  };
}

/**
 * Synchronizes `rootHandle` onto the tip prerequisite receipt in `prerequisiteReceipts` via `git merge-tree --write-tree`.
 *
 * Auto-flushes clean dirty edits on `rootHandle`, resolves stacked `baseBranch`, and materializes the 3-way merge.
 *
 * @param {GitWorktreeHandle}             rootHandle           - Task root worktree handle.
 * @param {readonly GitScopeReceipt[]}    prerequisiteReceipts - Terminal scope receipts of completed prerequisites.
 * @param {readonly string[] | undefined} [excludeGlobs]       - Optional glob patterns excluded from staging.
 *
 * @returns {Promise<ReconcileResult<GitSyncReceipt>>} Clean or conflicted synchronization receipt.
 */
export async function gitWorktreeSyncRoot(
  rootHandle: GitWorktreeHandle,
  prerequisiteReceipts: readonly GitScopeReceipt[],
  excludeGlobs?: readonly string[],
): Promise<ReconcileResult<GitSyncReceipt>> {
  const tipReceipt = prerequisiteReceipts[prerequisiteReceipts.length - 1];
  if (tipReceipt === undefined) {
    return {
      status: 'clean',
      data: GitSyncReceiptSchema.parse({ rebasedOntoRef: rootHandle.baseRef, baseBranch: rootHandle.baseBranch, updatedFiles: [] }),
    };
  }
  const c0Sha = rootHandle.baseRef;
  await gitWorktreeFlushCleanParentChanges(rootHandle, excludeGlobs);
  const resolvedBaseBranch = await resolvePrerequisiteBaseBranch(rootHandle, tipReceipt);
  const rootSynth = await synthesizeWorkingTreeCommitOverBase(rootHandle, c0Sha, excludeGlobs);
  const mergeOutcome = await executeStatelessMergeTree(rootHandle, tipReceipt.headRef, rootSynth.commitSha);
  await gitWorktreeMaterializeMerge(rootHandle, {
    targetHeadSha: tipReceipt.headRef,
    mergedTreeSha: mergeOutcome.mergedTreeSha,
    priorTreeSha: rootSynth.treeSha,
    conflictedPaths: mergeOutcome.conflictedPaths,
    nextBaseBranch: resolvedBaseBranch,
  });
  const diffOutput = await runGitCommand({ cwd: rootHandle.worktreePath, args: ['diff-tree', '-r', '--name-only', '-z', c0Sha, tipReceipt.headRef] });
  const updatedFiles = diffOutput.stdout.split('\0').filter((relPath) => relPath.length > 0);
  const receipt = GitSyncReceiptSchema.parse({ rebasedOntoRef: tipReceipt.headRef, baseBranch: resolvedBaseBranch, updatedFiles });
  if (mergeOutcome.clean) return { status: 'clean', data: receipt };
  return {
    status: 'conflict',
    conflictedSummary: `syncRoot conflict on paths: ${mergeOutcome.conflictedPaths.join(', ')}`,
    data: receipt,
  };
}
