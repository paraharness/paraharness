/**
 * Resolved working directory and environment variable map for spawning a local subprocess.
 *
 * Returned by `resolveWorktreeEnvAndCwd` after inspecting the active scope handle and resolving `EnvRef` entries.
 */
export interface ResolvedSubprocessEnvironment {
  /** Working directory for the spawned subprocess (`worktreePath` or `process.cwd()`). */
  readonly cwd: string;
  /** Resolved environment variables including any isolated `GIT_*` overrides. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Extracted `worktreePath` from the scope handle when present. */
  readonly worktreePath?: string;
}

/**
 * Parameters for spawning a detached OS subprocess group via `spawnDetachedSubprocess`.
 *
 * Bundles the command `argv`, resolved environment and `cwd`, and standard I/O descriptor configuration.
 */
export interface SpawnDetachedSubprocessParams {
  /** Non-empty command argument vector where index `0` is the executable. */
  readonly argv: readonly string[];
  /** Resolved working directory and environment variables. */
  readonly resolvedEnv: ResolvedSubprocessEnvironment;
  /** Standard input mode (`'ignore'` for closed stdin or `'pipe'` for writable stdin). */
  readonly stdinStdio?: 'ignore' | 'pipe';
}
