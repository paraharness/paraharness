/**
 * Execution options passed to `runGitCommand`.
 *
 * Configures the working directory, `git` CLI argument vector, optional `stdin` payload,
 * isolated environment variables, and whether non-zero exit codes should be returned instead of thrown.
 */
export interface GitCliCommandOptions {
  /** Working directory in which `git` is spawned. */
  readonly cwd: string;
  /** Argument vector passed to the `git` binary. */
  readonly args: readonly string[];
  /** Optional additional environment variables merged into the isolated worktree environment. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Optional standard input buffer or UTF-8 string piped to the subprocess. */
  readonly stdin?: string | Buffer;
  /** When `true`, resolves `GitCliCommandResult` on non-zero exit codes instead of throwing. */
  readonly allowNonZeroExit?: boolean;
  /** Optional `AbortSignal` to terminate the git subprocess early. */
  readonly signal?: AbortSignal;
}
