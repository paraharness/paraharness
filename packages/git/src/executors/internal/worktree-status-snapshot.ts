/**
 * Structured porcelain v2 status snapshot returned by `computeWorktreeStatusMap`.
 *
 * Separates tracked/untracked dirty file digests (`statusMap`), untracked path keys (`untrackedPaths`),
 * tracked deleted path keys (`deletedPaths`), and matched ignored paths (`ignoredPaths`).
 */
export interface WorktreeStatusSnapshot {
  /** Map from repository-relative file path to `${mode}:${sha256}` (or `'DELETED'`). */
  readonly statusMap: Readonly<Record<string, string>>;
  /** Set of repository-relative paths reported as untracked (`?`). */
  readonly untrackedPaths: ReadonlySet<string>;
  /** Set of repository-relative tracked paths deleted in the working tree. */
  readonly deletedPaths: ReadonlySet<string>;
  /** List of ignored paths reported when `--ignored=matching` is active. */
  readonly ignoredPaths: readonly string[];
}
