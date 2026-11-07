/**
 * Normalized candidate branch descriptor queued for a batch merge-train run.
 *
 * Identifies the candidate's label (branch name or ref), head commit SHA, and base commit SHA.
 */
export interface MergeTrainCandidate {
  /** Branch name or ref label for diagnostics and result reporting. */
  readonly label: string;
  /** Candidate tip commit SHA to rebase onto the merge train. */
  readonly headSha: string;
  /** Base commit SHA from which the candidate diverged. */
  readonly baseSha: string;
}
