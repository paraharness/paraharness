import type { PendingToolBatch } from './pending-tool-batch.js';

/**
 * Tool-batch pause state on `agent-frame` while iterating or suspending across assistant tool calls `(1..k)`.
 *
 * Preserves the declaration-ordered `PendingToolBatch` queue and any in-flight subprocess checkpoint.
 */
export interface ToolBatchPauseState {
  /** Discriminant identifying an in-progress assistant tool batch. */
  readonly kind: 'tool-batch';
  /** Persisted turn-batch state containing `completedResults`, `blockedCalls`, and `remainingCalls`. */
  readonly pendingToolBatch: PendingToolBatch;
  /** Optional pre-tool checkpoint token persisted while a post-flight-diffed subprocess tool is executing. */
  readonly inFlightPreToolCheckpoint?: string;
}
