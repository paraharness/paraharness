/**
 * Options for `TempGitHostRepoHandle.commitFiles`.
 */
export interface TempGitCommitOptions {
  /** Whether to push the newly created commit to the bare `origin` remote. */
  readonly pushOrigin?: boolean;
}

/**
 * Handle managing an isolated temporary Git host repository and bare `origin` remote for deterministic tests.
 *
 * Provides paths to the host repository, bare `origin` remote, and disjoint worktree base directory,
 * plus helpers to commit files and clean up all temporary directories.
 */
export interface TempGitHostRepoHandle {
  /** Base temporary directory enclosing `host`, `origin.git`, and `worktrees`. */
  readonly rootTmpDir: string;
  /** Absolute path to the initialized local Git host repository (`main` branch). */
  readonly repoPath: string;
  /** Alias for `repoPath` matching the `docs/plan/M3d-git.md` §5 fixture contract. */
  readonly hostRepoPath: string;
  /** Absolute path to the bare `origin` remote repository wired to `repoPath`. */
  readonly originPath: string;
  /** Alias for `originPath` matching the `docs/plan/M3d-git.md` §5 fixture contract. */
  readonly remoteRepoPath: string;
  /** Disjoint sibling directory where `<worktreesDir>/roots/<runId>` and `forks/<runId>/<forkId>` are created. */
  readonly worktreesDir: string;
  /** Initial `HEAD` commit SHA on `main` after repository initialization. */
  readonly initialCommitSha: string;
  /** Alias for `initialCommitSha` matching the `docs/plan/M3d-git.md` §5 fixture contract. */
  readonly baseSha: string;

  /**
   * Writes a set of relative file paths into `repoPath`, commits them onto the current branch, and optionally pushes to `origin`.
   *
   * Creates parent directories automatically and returns the newly created commit SHA.
   *
   * @param {Readonly<Record<string, string>>} files     - Map of repository-relative paths to UTF-8 contents.
   * @param {string}                           message   - Git commit message.
   * @param {TempGitCommitOptions}             [options] - Optional commit behavior flags (such as `pushOrigin`).
   *
   * @returns {Promise<string>} Commit SHA of the newly created commit.
   */
  commitFiles(
    files: Readonly<Record<string, string>>,
    message: string,
    options?: TempGitCommitOptions,
  ): Promise<string>;

  /**
   * Removes `rootTmpDir` (including `repoPath`, `originPath`, and `worktreesDir`) recursively.
   *
   * Safe to invoke inside `afterEach` or `finally` blocks.
   *
   * @returns {Promise<void>} Resolves once all temporary directories are deleted.
   */
  cleanup(): Promise<void>;
}
