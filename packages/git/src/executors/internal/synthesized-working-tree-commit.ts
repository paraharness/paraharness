/**
 * Synthesized tree SHA and commit SHA produced by staging a worktree's state into a temporary index.
 */
export interface SynthesizedWorkingTreeCommit {
  /** Root Git tree SHA produced by `git write-tree` against the temporary index. */
  readonly treeSha: string;
  /** Synthesized Git commit SHA produced by `git commit-tree` over `parentCommitSha`. */
  readonly commitSha: string;
}
