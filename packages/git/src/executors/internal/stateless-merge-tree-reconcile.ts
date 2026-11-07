import type {
  GitScopeReceipt,
  GitSyncReceipt,
  GitWorktreeHandle,
  ReconcileResult,
} from '@harness-dsl/core';
import {
  gitWorktreeCommitChild,
  gitWorktreeInspectNonMutating,
} from './git-worktree-commit-child.js';
import {
  gitWorktreeSyncChild,
  gitWorktreeSyncRoot,
} from './git-worktree-sync-child-and-root.js';

/**
 * Captures a 100% non-mutating `GitScopeReceipt` for `handle` using a temporary index file.
 *
 * Reuses `HEAD` directly when the working tree is clean and `HEAD` descends from `baseRef`,
 * and pins `refs/harness/candidates/<run-id>/<branch-index>` for child fork worktrees.
 *
 * @param {GitWorktreeHandle}             handle         - Active worktree handle to inspect.
 * @param {readonly string[] | undefined} [excludeGlobs] - Optional glob patterns excluded from staging.
 *
 * @returns {Promise<GitScopeReceipt>} Validated `GitScopeReceipt` with `headRef`, `diffStat`, and `mutatedFiles`.
 */
export function inspectGitWorktreeNonMutating(
  handle: GitWorktreeHandle,
  excludeGlobs?: readonly string[],
): Promise<GitScopeReceipt> {
  return gitWorktreeInspectNonMutating(handle, excludeGlobs);
}

/**
 * Reconciles `child` into `parent` via stateless 3-way `git merge-tree --write-tree` without polluting `parent` on conflict.
 *
 * Leaves `child.baseRef` untouched on a clean merge, or materializes conflicts into `child` and advances `child.baseRef = C_1` on conflict.
 *
 * @param {GitWorktreeHandle}             child          - Completed child worktree handle.
 * @param {GitWorktreeHandle}             parent         - Target parent worktree handle.
 * @param {readonly string[] | undefined} [excludeGlobs] - Optional glob patterns excluded from staging.
 *
 * @returns {Promise<ReconcileResult<GitScopeReceipt>>} Clean or conflicted reconciliation result.
 */
export function commitChildViaMergeTree(
  child: GitWorktreeHandle,
  parent: GitWorktreeHandle,
  excludeGlobs?: readonly string[],
): Promise<ReconcileResult<GitScopeReceipt>> {
  return gitWorktreeCommitChild(child, parent, excludeGlobs);
}

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
export function syncChildViaMergeTree(
  parent: GitWorktreeHandle,
  pausedChild: GitWorktreeHandle,
  excludeGlobs?: readonly string[],
): Promise<ReconcileResult<GitSyncReceipt>> {
  return gitWorktreeSyncChild(parent, pausedChild, excludeGlobs);
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
export function syncRootViaMergeTree(
  rootHandle: GitWorktreeHandle,
  prerequisiteReceipts: readonly GitScopeReceipt[],
  excludeGlobs?: readonly string[],
): Promise<ReconcileResult<GitSyncReceipt>> {
  return gitWorktreeSyncRoot(rootHandle, prerequisiteReceipts, excludeGlobs);
}
