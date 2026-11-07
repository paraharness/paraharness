/**
 * Options for `computeWorktreeStatusMap` when scanning a worktree via `git status --porcelain=v2 -z`.
 *
 * Configures optional user `excludeGlobs`, whether `repo` is `'.'`, and whether `--ignored=matching`
 * should be enabled to surface newly gitignored files.
 */
export interface ComputeWorktreeStatusOptions {
  /** Optional glob patterns excluded from the status map (except `**\/.gitignore`). */
  readonly excludeGlobs?: readonly string[];
  /** Optional paths that were already ignored at checkpoint creation time. */
  readonly baselineIgnoredPaths?: ReadonlySet<string>;
  /** When `true`, passes `--ignored=matching` to `git status` to detect files hidden behind `.gitignore` edits. */
  readonly includeMatchingIgnored?: boolean;
}
