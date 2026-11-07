/**
 * Handle to a real temporary filesystem workspace created for deterministic adapter tests.
 *
 * Provides the canonical `rootDir` / `worktreePath`, optional git `baseRef` commit SHA, and cleanup method.
 */
export interface TempFsWorkspaceHandle {
  /** Canonical realpath of the temporary workspace directory. */
  readonly rootDir: string;

  /** Canonical worktree path alias matching `ScopeHandle` (`worktreePath === rootDir`). */
  readonly worktreePath: string;

  /** Initial git commit SHA when `options.initGit` is enabled, or `'HEAD'` otherwise. */
  readonly baseRef: string;

  /**
   * Removes the temporary workspace directory and any nested files or symlinks.
   *
   * Safe to invoke inside `afterEach` or `afterAll` teardown blocks.
   *
   * @returns {Promise<void>} Resolves once all temporary directories are removed.
   */
  cleanup(): Promise<void>;
}
