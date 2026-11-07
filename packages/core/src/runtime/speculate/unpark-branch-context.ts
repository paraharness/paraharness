import type { SpeculateContinuationFrame } from '../../ports/speculate-continuation-frame.js';

/**
 * Context supplied to `unparkEscalatedTournamentBranch()` for unparking a single escalated branch.
 *
 * Carries the branch index, live child scope handle, and frame persistence callback.
 *
 * @template THandle Runtime handle type of the active `BranchableScope`.
 */
export interface UnparkBranchContext<THandle = unknown> {
  /** Zero-based index of the parked branch to unpark. */
  readonly branchIndex: number;
  /** Live child scope handle for the parked branch. */
  readonly handle: THandle;
  /** Pre-computed branch input payloads (`0..B-1`) from `mapBranches`. */
  readonly branchInputs: readonly unknown[];
  /** Callback persisting an updated `SpeculateContinuationFrame` into `LedgerStore`. */
  readonly persistFrame: (frame: SpeculateContinuationFrame) => Promise<void>;
}
