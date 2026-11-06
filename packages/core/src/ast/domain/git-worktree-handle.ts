/**
 * Runtime scope handle for an isolated Copy-on-Write Git worktree (`git.cowWorktree`).
 *
 * Tracks the physical `worktreePath`, isolated `gitDirPath`, immutable `baseRef`, stacked
 * `baseBranch`, and any `unresolvedConflictPaths` mapped to their conflict-time digests.
 */
export interface GitWorktreeHandle {
  /** Absolute or host-relative filesystem path to the isolated worktree working directory. */
  readonly worktreePath: string;
  /** Path to the worktree's isolated `.git/worktrees/<id>` metadata directory. */
  readonly gitDirPath: string;
  /** Base commit SHA against which working-tree diffs and squashes are computed. */
  readonly baseRef: string;
  /** Target upstream or prerequisite base branch name (such as `'main'` or `'fix/#102'`). */
  readonly baseBranch: string;
  /** Optional feature branch name pushed for this worktree. */
  readonly branchName?: string;
  /** Optional latest synthesized or committed HEAD SHA. */
  readonly headRef?: string;
  /** Conflicted file paths mapped to their conflict-materialized `${mode}:${sha256}` digests (`'MISSING'` if absent). */
  readonly unresolvedConflictPaths: Readonly<Record<string, string>>;
}
