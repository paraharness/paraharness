/**
 * Validated abort metadata produced by `git.snapshotAndReset()`.
 *
 * Captures the immutable host git ref (`abortedSnapshotRef`) pinning the aborted working tree
 * alongside the `resetToRef` commit SHA to which the worktree was restored.
 */
export interface GitAbortMeta extends Record<string, unknown> {
  /** Host repository git ref pinning the snapshot of the aborted working tree (`refs/harness/aborted/<run-id>/<stepExecId>`). */
  readonly abortedSnapshotRef: string;
  /** Base commit SHA to which the worktree was reset. */
  readonly resetToRef: string;
}
