/**
 * Normalized GitHub issue record emitted by `GithubIssuesTrackerAdapter.poll()`.
 *
 * Provides typed issue metadata and normalized label strings consumed by `M.lane(...).tracker(...)`
 * projection callbacks.
 */
export interface GithubIssueRecord {
  /** Issue number within the repository. */
  readonly number: number;
  /** Issue title text. */
  readonly title: string;
  /** Markdown issue body text, or `null` when empty. */
  readonly body: string | null;
  /** Normalized list of label names attached to the issue. */
  readonly labels: readonly string[];
  /** Optional GitHub issue state (`'open'` or `'closed'`). */
  readonly state?: string;
  /** Optional browser URL for the GitHub issue. */
  readonly htmlUrl?: string;
}
