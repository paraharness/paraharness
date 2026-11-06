import type { SpeculateContinuationFrame } from '../../ports/speculate-continuation-frame.js';

/**
 * Context supplied to `executeWinnerRefinementAndCommit()` when committing the tournament winner.
 *
 * Carries the winning branch index, arbiter verdict, live candidate handles map, and persistence callback.
 *
 * @template THandle Runtime handle type of the active `BranchableScope`.
 */
export interface WinnerRefinementCommitContext<THandle = unknown> {
  /** Zero-based index of the winning candidate branch. */
  readonly winnerBranchIndex: number;
  /** Optional structured arbiter verdict passed to `refineWinnerWhen`. */
  readonly verdict: unknown;
  /** Map of all candidate branch indices to their live scope handles. */
  readonly handlesByBranch: ReadonlyMap<number, THandle>;
  /** Callback persisting an updated `SpeculateContinuationFrame` into `LedgerStore`. */
  readonly persistFrame: (frame: SpeculateContinuationFrame) => Promise<void>;
}
