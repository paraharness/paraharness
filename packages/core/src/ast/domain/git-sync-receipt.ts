/**
 * Validated synchronization receipt produced by `git.cowWorktree` (`syncChild` and `syncRoot`).
 *
 * Records the upstream commit SHA (`rebasedOntoRef`), updated `baseBranch`, and `updatedFiles`
 * touched when rebasing or 3-way merging a worktree.
 */
export interface GitSyncReceipt extends Record<string, unknown> {
  /** Target commit SHA onto which the worktree was rebased or 3-way merged. */
  readonly rebasedOntoRef: string;
  /** Updated base branch name after synchronization. */
  readonly baseBranch: string;
  /** Repository-relative paths updated during the synchronization merge. */
  readonly updatedFiles: readonly string[];
}
