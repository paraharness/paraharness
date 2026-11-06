import type { SpeculateContinuationFrame } from '../../ports/speculate-continuation-frame.js';

/**
 * Outcome returned by `unparkEscalatedTournamentBranch()` after resolving or aborting a parked branch.
 *
 * Distinguishes exogenous human escalation resumption from upward child-interrupt abort.
 */
export interface UnparkBranchResult {
  /** Whether the parked branch resumed via human decision or aborted on an upward child interrupt. */
  readonly status: 'resumed' | 'aborted-on-child-interrupt';
  /** Updated `SpeculateContinuationFrame` after unparking. */
  readonly updatedFrame: SpeculateContinuationFrame;
  /** Optional serialized `ABORTED_ON_CHILD_INTERRUPT` tool result JSON. */
  readonly abortResultJson?: string;
}
