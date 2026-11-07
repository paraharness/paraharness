/**
 * Parameters for `materializeInFlightMergeIntoWorktree` and `finalizeMaterializedMergeMetadata`.
 *
 * Carries the target commit SHA ($C_1$ or $C_{\text{prereq}}$), merged tree SHA ($T_{\text{merged}}$),
 * prior working-tree SHA ($T_{\text{child}}$ or $T_{\text{root}}$), conflicted paths, and optional updated `baseBranch`.
 */
export interface MaterializeInFlightMergeParams {
  /** Target commit SHA onto which `HEAD`, `.git/index`, and `baseRef` advance. */
  readonly targetHeadSha: string;
  /** Top-level tree SHA emitted by `git merge-tree --write-tree`. */
  readonly mergedTreeSha: string;
  /** Prior synthesized tree SHA of the child or root worktree before the merge. */
  readonly priorTreeSha: string;
  /** Repository-relative paths reported as conflicted by `git merge-tree`. */
  readonly conflictedPaths: readonly string[];
  /** Optional updated base branch name (such as a stacked prerequisite branch). */
  readonly nextBaseBranch?: string;
}
