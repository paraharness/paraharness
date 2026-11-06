/**
 * Contextual metadata passed to a pool selection strategy during candidate resolution.
 *
 * Carries the active `runId`, retry attempt counter, wall-clock timestamp, and any sticky
 * candidate identifier previously bound to `runId`.
 */
export interface PoolSelectionContext {
  /** Identifier of the capacity pool being queried. */
  readonly poolId: string;
  /** Identifier of the active flow run requesting a candidate. */
  readonly runId: string;
  /** Zero-based retry or loop escalation attempt index. */
  readonly retryAttempt: number;
  /** Current wall-clock timestamp in milliseconds. */
  readonly nowMs: number;
  /** Previously acquired candidate identifier for run-sticky seat affinity, if any. */
  readonly stickyCandidateId?: string;
}
