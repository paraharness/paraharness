import type { ContinuationFrame } from './continuation-frame.types.js';

/**
 * Trigger metadata recorded on `ForkBatchContinuationFrame.pendingPauseTriggers` when a child fork
 * raises an upward interrupt during a turn-batch barrier wait.
 *
 * Identifies the raising fork epoch, interrupt identifier, serialized payload, and affected partitions.
 */
export interface PendingPauseTriggerRecord {
  /** Monotonic `suspendedForkId` (`${forkId}#${suspensionEpoch}`) of the fork that raised the interrupt. */
  readonly triggeredByForkId: string;
  /** Identifier of the raised `InterruptNode`. */
  readonly interruptId: string;
  /** JSON-serialized payload of the raised interrupt. */
  readonly interruptPayloadJson: string;
  /** Partition identifiers computed by `.pauseSiblingForksInPartitions()`. */
  readonly affectedPartitions: readonly string[];
}

/**
 * Per-fork execution entry inside a `ForkBatchContinuationFrame`.
 *
 * Tracks the child fork's lifecycle status, 3-way commit retry state, suspension epoch,
 * scope checkpoints, and nested continuation stack.
 */
export interface ForkBatchEntryRecord {
  /** Logical identifier of the child fork. */
  readonly forkId: string;
  /** Monotonic `suspendedForkId` when resuming a prior `SuspendedForkRecord` via `resumeFork`. */
  readonly suspendedForkId?: string;
  /** Parent assistant turn `callId` that dispatched this fork or `resumeFork` batch. */
  readonly callId: string;
  /** Name of the `.fork()` capability tool (or `'resumeFork'`). */
  readonly toolName: string;
  /** Active partition identifiers extracted for this child fork. */
  readonly activePartitions: readonly string[];
  /** Lifecycle status of the child fork within the batch. */
  readonly status:
    | 'RUNNING'
    | 'CHILD_COMMITTED'
    | 'COMPLETED'
    | 'SUSPENDED'
    | 'FAILED'
    | 'ABORTED';
  /** Number of 3-way `commitChild` conflict-bounce retries attempted so far. */
  readonly conflictRetryCount: number;
  /** Whether `conflictCleanCheck` is armed on this child fork's scope handle. */
  readonly conflictCheckArmed: boolean;
  /** Monotonic suspension epoch counter for this `forkId`. */
  readonly suspensionEpoch: number;
  /** Parent checkpoint marker persisted after `syncChild` completes during `resumeFork`. */
  readonly syncedToParentCheckpoint?: string;
  /** JSON-serialized `ReconcileResult` from `syncChild` persisted for crash-safe resumption. */
  readonly syncResultJson?: string;
  /** Whether the resumption `tool_result` or synthetic `user` frame has already been injected. */
  readonly resumeFrameInjected?: boolean;
  /** Serialized child scope checkpoint captured prior to suspension. */
  readonly childScopeCheckpoint?: string;
  /** JSON-serialized validated child output payload once completed. */
  readonly outputJson?: string;
  /** JSON-serialized scope receipt returned by a clean `commitChild`. */
  readonly committedReceiptJson?: string;
  /** JSON-serialized wire `tool_result` payload recorded when the fork entry settles. */
  readonly toolResultJson?: string;
  /** Whether the child's deduplicated lesson outcomes have been flushed to `LessonStore`. */
  readonly lessonsFlushed?: boolean;
  /** Nested outer-to-inner continuation stack for the child executable. */
  readonly continuationStack: readonly ContinuationFrame[];
}

/**
 * Serialized continuation frame for a concurrent batch of downward `.fork()` or `resumeFork` calls (`kind: 'fork-batch-frame'`).
 *
 * Coordinates turn-batch barrier synchronization, sibling interrupt pausing, and sequential 3-way child commits.
 */
export interface ForkBatchContinuationFrame {
  /** Discriminant identifying a downward fork batch continuation frame. */
  readonly kind: 'fork-batch-frame';
  /** Step execution identifier of the parent actor that dispatched the batch. */
  readonly parentStepExecId: string;
  /** Upward interrupt triggers accumulated while waiting at the turn-batch sibling barrier. */
  readonly pendingPauseTriggers?: readonly PendingPauseTriggerRecord[];
  /** Ordered child fork entries executing or settled within this batch. */
  readonly forks: readonly ForkBatchEntryRecord[];
}
