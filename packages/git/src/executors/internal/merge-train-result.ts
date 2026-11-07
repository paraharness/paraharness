/**
 * Outcome of executing a cumulative batch merge-train pass (`git.mergeQueue`).
 *
 * Reports the updated `targetBranch` tip commit SHA, landed candidate labels, evicted candidate labels,
 * and total `verifyWith` executions performed.
 */
export interface MergeTrainResult {
  /** Target upstream branch updated by the merge train. */
  readonly targetBranch: string;
  /** Final fast-forwarded commit SHA on `targetBranch`. */
  readonly headRef: string;
  /** Ordered list of candidate branch labels that passed verification and landed. */
  readonly landedBranches: readonly string[];
  /** Ordered list of offending candidate branch labels isolated and evicted during bisection or conflict. */
  readonly evictedBranches: readonly string[];
  /** Total number of `verifyWith` check executions run across the batch. */
  readonly verificationRuns: number;
}
