/**
 * Validated scope inspection receipt produced by `git.cowWorktree` (`inspect` and `commitChild`).
 *
 * Summarizes the worktree's current `headRef`, `baseRef`, `baseBranch`, `diffStat`, and
 * `mutatedFiles` for downstream step input mappers and speculative arbiters.
 */
export interface GitScopeReceipt extends Record<string, unknown> {
  /** Commit SHA representing the inspected worktree state. */
  readonly headRef: string;
  /** Immutable base commit SHA of the worktree. */
  readonly baseRef: string;
  /** Optional feature branch name associated with the worktree. */
  readonly branchName?: string;
  /** Upstream or stacked-PR prerequisite base branch name. */
  readonly baseBranch: string;
  /** Formatted `git diff --stat` summary between `baseRef` and `headRef`. */
  readonly diffStat: string;
  /** Repository-relative paths of all files mutated between `baseRef` and `headRef`. */
  readonly mutatedFiles: readonly string[];
}
