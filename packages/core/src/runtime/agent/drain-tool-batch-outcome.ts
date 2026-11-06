import type { PendingToolBatch } from '../../ports/pending-tool-batch.js';
import type { InterruptEdgeResolution } from './interrupt-edge-resolution.js';

/**
 * Outcome returned by `drainPendingToolBatch()` after processing `PendingToolBatch.remainingCalls`.
 *
 * Reports whether the batch completed normally (`'completed'`), suspended on prerequisites (`'suspended'`),
 * or exited via an unhandled/replacement interrupt (`'interrupted'`).
 *
 * @template THandle Runtime handle type of the active isolation scope.
 */
export interface DrainToolBatchOutcome<THandle = unknown> {
  /** Terminal status of the tool batch drain. */
  readonly status: 'completed' | 'suspended' | 'interrupted';
  /** Settled `PendingToolBatch` record. */
  readonly batch: PendingToolBatch;
  /** Interrupt resolution metadata when `status === 'interrupted'`. */
  readonly interruptResolution?: InterruptEdgeResolution<THandle>;
}
