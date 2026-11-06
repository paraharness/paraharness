import type {
  ForkBatchEntryRecord,
  PendingPauseTriggerRecord,
} from '../../ports/fork-batch-continuation-frame.js';

/**
 * Result returned by `coordinateTurnBatchInterruptBarrier()` after persisting the raising and paused sibling forks.
 *
 * Provides the updated raising fork entry, the pause trigger record, and all newly paused sibling entries.
 */
export interface TurnBatchBarrierResult {
  /** Updated `ForkBatchEntryRecord` for the raising child fork. */
  readonly updatedRaisingEntry: ForkBatchEntryRecord;
  /** Recorded pause trigger metadata. */
  readonly trigger: PendingPauseTriggerRecord;
  /** Sibling fork entries transitioned to `'SUSPENDED'`. */
  readonly pausedSiblings: readonly ForkBatchEntryRecord[];
}
