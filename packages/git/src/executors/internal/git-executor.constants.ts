/**
 * Default maximum file size in bytes (1 MiB) for untracked files staged directly into temporary git index checkpoints.
 */
export const DEFAULT_MAX_UNTRACKED_FILE_SIZE_BYTES = 1_048_576;

/**
 * Implicit glob patterns always excluded from clones and checkpoints when `repo` is `'.'`.
 */
export const IMPLICIT_REPO_EXCLUDE_GLOBS: readonly string[] = Object.freeze([
  '.harness/state.sqlite*',
  '.harness/lesson*',
  '.git/**',
]);

/**
 * Regular expression matching the opening `<<<<<<< ` conflict marker line.
 */
export const CONFLICT_START_REGEX = /^<{7} /;

/**
 * Regular expression matching the middle `=======` conflict separator line (`^={7}( |$)`).
 */
export const CONFLICT_SEP_REGEX = /^={7}(?: |$)/;

/**
 * Regular expression matching the closing `>>>>>>> ` conflict marker line.
 */
export const CONFLICT_END_REGEX = /^>{7} /;

/**
 * Deterministic git author and committer identity and epoch timestamps used when synthesizing internal worktree commits.
 */
export const HARNESS_GIT_IDENTITY_ENV: Readonly<Record<string, string>> = Object.freeze({
  GIT_AUTHOR_NAME: 'Paraharness Runtime',
  GIT_AUTHOR_EMAIL: 'runtime@paraharness.local',
  GIT_COMMITTER_NAME: 'Paraharness Runtime',
  GIT_COMMITTER_EMAIL: 'runtime@paraharness.local',
  GIT_AUTHOR_DATE: '1700000000 +0000',
  GIT_COMMITTER_DATE: '1700000000 +0000',
});

/**
 * Memoized cache of compiled `picomatch` exclusion predicates keyed by null-delimited glob patterns.
 */
export const COMPILED_EXCLUDE_MATCHER_CACHE: Map<string, (relPath: string) => boolean> = new Map<
  string,
  (relPath: string) => boolean
>();

