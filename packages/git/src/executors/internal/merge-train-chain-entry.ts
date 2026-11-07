import type { MergeTrainCandidate } from './merge-train-candidate.js';

/**
 * Speculative cumulative rebase chain entry ($R_i$) in a batch merge train.
 *
 * Pairs the original `MergeTrainCandidate` with its cumulatively rebased commit SHA $R_i$.
 */
export interface MergeTrainChainEntry {
  /** Candidate branch included at this step of the cumulative rebase chain. */
  readonly candidate: MergeTrainCandidate;
  /** Commit SHA of the cumulative rebase tip $R_i$ after applying `candidate`. */
  readonly rebasedSha: string;
}
