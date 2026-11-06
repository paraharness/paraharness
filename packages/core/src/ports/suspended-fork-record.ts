import type { ContinuationFrame } from './continuation-frame.types.js';

/**
 * Durable ledger record representing a downward child fork suspended by an upward interrupt
 * (`INTERRUPT_RAISED`) or paused at the turn-batch barrier by a sibling interrupt (`PAUSED_BY_SIBLING_INTERRUPT`).
 *
 * Resumed or aborted on the parent's single timeline via the built-in `resumeFork` tool.
 */
export interface SuspendedForkRecord {
  /** Monotonic suspension identifier formatted as `${forkId}#${suspensionEpoch}`. */
  readonly suspendedForkId: string;
  /** Logical identifier of the child fork. */
  readonly forkId: string;
  /** Positive integer suspension epoch counter for `forkId`. */
  readonly suspensionEpoch: number;
  /** Identifier of the enclosing flow run. */
  readonly runId: string;
  /** Step execution identifier of the parent actor that spawned the fork. */
  readonly parentStepExecId: string;
  /** Name of the `.fork()` capability tool that created the child fork. */
  readonly forkToolName: string;
  /** Active logical partitions associated with the suspended fork. */
  readonly activePartitions: readonly string[];
  /** Reason the child fork entered suspension. */
  readonly suspensionReason: 'INTERRUPT_RAISED' | 'PAUSED_BY_SIBLING_INTERRUPT';
  /** Optional `suspendedForkId` of the sibling fork that triggered a barrier pause. */
  readonly triggeredByForkId?: string;
  /** Optional loop phase (`'act' | 'evaluate'`) that raised the upward interrupt. */
  readonly raisedByPhase?: 'act' | 'evaluate';
  /** Number of 3-way `commitChild` conflict retries accumulated prior to suspension. */
  readonly conflictRetryCount: number;
  /** Whether `conflictCleanCheck` is armed on the child scope handle. */
  readonly conflictCheckArmed: boolean;
  /** Optional parent checkpoint marker persisted after `syncChild` during `resumeFork`. */
  readonly syncedToParentCheckpoint?: string;
  /** Optional JSON-serialized `ReconcileResult` from `syncChild`. */
  readonly syncResultJson?: string;
  /** Whether the resumption wire frame has already been injected into the child transcript. */
  readonly resumeFrameInjected?: boolean;
  /** Optional identifier of the raised `InterruptNode`. */
  readonly interruptId?: string;
  /** Optional JSON-serialized payload of the raised interrupt. */
  readonly interruptPayloadJson?: string;
  /** Optional `callId` of the interrupt tool call on the inner `.act()` `agent-frame`. */
  readonly suspendedAtCallId?: string;
  /** Optional serialized scope checkpoint of `childHandle` captured upon suspension. */
  readonly childScopeCheckpoint?: string;
  /** Outer-to-inner serialized continuation stack (`[loop-frame, agent-frame]`). */
  readonly continuationStack: readonly ContinuationFrame[];
}
