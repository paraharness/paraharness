/**
 * Stateless 3-way `git merge-tree --write-tree -z` execution result.
 */
export interface StatelessMergeTreeResult {
  /** Whether the 3-way merge completed without file-level or content-level conflicts. */
  readonly clean: boolean;
  /** Top-level Git tree SHA synthesized by `git merge-tree --write-tree`. */
  readonly mergedTreeSha: string;
  /** Posix-normalized repository-relative paths that suffered 3-way merge conflicts. */
  readonly conflictedPaths: readonly string[];
}
