/**
 * Options for initializing a temporary filesystem workspace in tests.
 *
 * Configures initial relative file contents, optional symlinks, and optional git repository initialization.
 */
export interface TempFsWorkspaceOptions {
  /** Map of relative POSIX file paths to initial UTF-8 string contents. */
  readonly files?: Readonly<Record<string, string>>;
  /** Map of relative symlink paths to their target paths. */
  readonly symlinks?: Readonly<Record<string, string>>;
  /** Whether to initialize a git repository and create an initial baseline commit (`false` default). */
  readonly initGit?: boolean;
}
