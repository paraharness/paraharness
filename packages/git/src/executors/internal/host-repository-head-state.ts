/**
 * Resolved `HEAD` commit SHA and default branch name of a host Git repository.
 */
export interface HostRepositoryHeadState {
  /** Current `HEAD` commit SHA resolved via `git rev-parse HEAD`. */
  readonly baseRef: string;
  /** Symbolic branch name of `HEAD` or `'main'` when detached. */
  readonly baseBranch: string;
}
