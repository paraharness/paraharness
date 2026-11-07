/**
 * Worktree-local `.git` and `node_modules` integrity verification verdict.
 */
export interface WorktreeIntegrityVerdict {
  /** Whether all worktree-local `.git` metadata and `node_modules` match the baseline checkpoint. */
  readonly intact: boolean;
  /** Human-readable description of the tampered artifact when `intact` is `false`. */
  readonly reason?: string;
}
