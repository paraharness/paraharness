import type { ContinuationFrame } from '@metaharness/core';

/**
 * Parameter object for `updateContinuationStackInPg`.
 *
 * Bundles the enclosing run ID, step execution ID, continuation stack, and optional
 * updated base scope checkpoint.
 */
export interface UpdateContinuationStackParams {
  /** Enclosing flow run identifier. */
  readonly runId: string;
  /** Target step execution identifier. */
  readonly stepExecId: string;
  /** Updated outer-to-inner continuation stack. */
  readonly continuationStack: readonly ContinuationFrame[];
  /** Optional updated base scope checkpoint. */
  readonly baseScopeCheckpoint?: string;
}
