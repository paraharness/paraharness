import type {
  ForkBatchContinuationFrame,
  PendingPauseTriggerRecord,
} from '../../ports/fork-batch-continuation-frame.js';

/**
 * Outcome returned by `executeForkBatch()` or `executeResumeForkBatch()` for the parent turn batch.
 *
 * Provides per-`callId` serialized `tool_result` strings and the final `ForkBatchContinuationFrame`.
 */
export interface ForkBatchExecutionResult {
  /** Map of parent tool `callId` to its serialized `tool_result` JSON string. */
  readonly toolResultsByCallId: ReadonlyMap<string, { readonly content: string; readonly isError: boolean }>;
  /** Final settled `ForkBatchContinuationFrame`. */
  readonly batchFrame: ForkBatchContinuationFrame;
  /** Any new upward pause triggers captured at the turn-batch barrier. */
  readonly pauseTriggers: readonly PendingPauseTriggerRecord[];
}
