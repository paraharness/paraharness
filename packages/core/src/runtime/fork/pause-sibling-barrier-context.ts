import type { PendingPauseTriggerRecord } from '../../ports/fork-batch-continuation-frame.js';

/**
 * Parameters for pausing a sibling fork at its turn or tool boundary during a turn-batch interrupt barrier.
 *
 * Carries the pause trigger metadata and the sibling fork's isolated scope handle.
 *
 * @template THandle Runtime handle type of the active `BranchableScope`.
 */
export interface PauseSiblingBarrierContext<THandle = unknown> extends PendingPauseTriggerRecord {
  /** Isolated scope handle of the sibling fork being paused. */
  readonly siblingHandle: THandle;
}
