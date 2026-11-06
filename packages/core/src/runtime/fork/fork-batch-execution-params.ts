import type { AgentNode } from '../../ast/agent-node.js';
import type { StepASTNode } from '../../ast/domain-ast.types.js';
import type { ForkCapabilityNode } from '../../ast/fork-capability-node.js';
import type { BranchableScope } from '../../ports/branchable-scope.js';
import type { CompiledWirePrefix } from '../../ports/compiled-wire-prefix.js';
import type { ContinuationFrame } from '../../ports/continuation-frame.types.js';
import type {
  ForkBatchContinuationFrame,
  ForkBatchEntryRecord,
  PendingPauseTriggerRecord,
} from '../../ports/fork-batch-continuation-frame.js';
import type { HumanAdapter } from '../../ports/human-adapter.js';
import type { LeaseDelta } from '../../ports/lease-delta.js';
import type { LedgerStore } from '../../ports/ledger-store.js';
import type { LessonOutcome } from '../../ports/lesson-outcome.types.js';
import type { LessonStore } from '../../ports/lesson-store.js';
import type { ModelDriver } from '../../ports/model-driver.js';
import type { StepExecutionContext } from '../../ports/step-execution-context.js';
import type { SuspendedForkRecord } from '../../ports/suspended-fork-record.js';
import type { ScopeLockManager } from '../locks/scope-lock-manager.js';
import type { StepContinuationQueue } from '../locks/step-continuation-queue.js';
import type { PoolManager } from '../pools/pool-manager.js';

/**
 * Outcome returned by a child step execution inside a downward `.fork()` or `resumeFork` batch.
 *
 * Distinguishes normal completion (`status: 'completed'`) from an upward interrupt raised to the parent (`status: 'interrupt-raised'`).
 *
 * @template TOut Validated output payload type of the child executable.
 */
export interface ChildForkExecutionOutcome<TOut = unknown> {
  /** Discriminant indicating whether the child completed or raised an upward interrupt. */
  readonly status: 'completed' | 'interrupt-raised';
  /** Validated output payload when `status === 'completed'`. */
  readonly output?: TOut;
  /** Final leaf message ID of the child transcript. */
  readonly leafMessageId?: string | null;
  /** Deduplicated lesson outcomes accumulated during child execution. */
  readonly accumulatedLessonOutcomes?: Readonly<Record<string, LessonOutcome>>;
  /** Raised interrupt identifier when `status === 'interrupt-raised'`. */
  readonly interruptId?: string;
  /** Validated interrupt payload when `status === 'interrupt-raised'`. */
  readonly interruptPayload?: unknown;
  /** Phase that raised the interrupt (`'act'` vs `'evaluate'`). */
  readonly raisedByPhase?: 'act' | 'evaluate';
  /** Tool call ID that raised the interrupt when raised from an `.act()` tool call. */
  readonly suspendedAtCallId?: string;
  /** Serialized child continuation stack at the moment of suspension or completion. */
  readonly continuationStack: readonly ContinuationFrame[];
}

/**
 * Single downward fork dispatch descriptor inside a parent assistant turn batch.
 *
 * Pairs the wire-level `callId`, `ForkCapabilityNode`, and parsed request arguments.
 *
 * @template THandle Runtime handle type of the active `BranchableScope`.
 */
export interface ForkDispatchCallItem<THandle = unknown> {
  /** Wire-level tool `callId` from the parent assistant turn. */
  readonly callId: string;
  /** Logical fork identifier (`forkId`). */
  readonly forkId: string;
  /** Matched `ForkCapabilityNode` on the parent agent. */
  readonly capability: ForkCapabilityNode<unknown, unknown, unknown, unknown, THandle>;
  /** Raw JSON arguments passed to the `.fork()` tool call. */
  readonly argsJson: string;
}

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

/**
 * Context supplied to `coordinateTurnBatchInterruptBarrier()` when a child fork raises an upward interrupt.
 *
 * Combines the raising child's execution outcome, child scope handle, sibling entries, and sibling handles map.
 *
 * @template THandle Runtime handle type of the active `BranchableScope`.
 */
export interface TurnBatchBarrierContext<THandle = unknown> extends ChildForkExecutionOutcome<unknown> {
  /** Isolated scope handle of the child fork that raised the interrupt. */
  readonly childHandle: THandle;
  /** All fork entries in the current batch. */
  readonly siblingEntries: readonly ForkBatchEntryRecord[];
  /** Map of `forkId` to live child scope handle for active siblings. */
  readonly handlesByForkId: ReadonlyMap<string, THandle>;
}

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

/**
 * Parameters for reconciling a completed child fork via 3-way `commitChild` with conflict-bounce retries.
 *
 * Supplies the batch execution context, child entry, isolated `childHandle`, child AST node, and outcome.
 *
 * @template THandle Runtime handle type of the active `BranchableScope`.
 */
export interface ReconcileChildForkParams<THandle = unknown> {
  /** Enclosing fork batch execution parameters. */
  readonly batchParams: ForkBatchExecutionParams<THandle>;
  /** Current `ForkBatchEntryRecord` for the child fork. */
  readonly entry: ForkBatchEntryRecord;
  /** Isolated child scope handle. */
  readonly childHandle: THandle;
  /** Child `AgentNode` or `LoopNode` executable. */
  readonly childNode: StepASTNode<unknown, unknown, THandle>;
  /** Validated child input payload. */
  readonly childInput: unknown;
  /** Completed child execution outcome. */
  readonly outcome: ChildForkExecutionOutcome<unknown>;
  /** Callback persisting an updated `ForkBatchEntryRecord` into `LedgerStore`. */
  readonly persistEntryUpdate: (updatedEntry: ForkBatchEntryRecord) => Promise<void>;
}

/**
 * Parameters for resuming a single `SuspendedForkRecord` via `resumeSuspendedForkEntry()`.
 *
 * Supplies the batch execution context, persisted `SuspendedForkRecord`, current `ForkBatchEntryRecord`,
 * resolution summary text, and entry persistence callback.
 *
 * @template THandle Runtime handle type of the active `BranchableScope`.
 */
export interface ResumeSuspendedForkEntryParams<THandle = unknown> {
  /** Enclosing fork batch execution parameters. */
  readonly batchParams: ForkBatchExecutionParams<THandle>;
  /** Persisted `SuspendedForkRecord` being resumed. */
  readonly record: SuspendedForkRecord;
  /** Current `ForkBatchEntryRecord` in the `resumeFork` batch. */
  readonly entry: ForkBatchEntryRecord;
  /** Parent resolution summary text from `resumeFork`. */
  readonly resolutionSummary: string;
  /** Callback persisting an updated `ForkBatchEntryRecord` into `LedgerStore`. */
  readonly persistEntryUpdate: (updatedEntry: ForkBatchEntryRecord) => Promise<void>;
}

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

/**
 * Parameters for executing a concurrent batch of downward `.fork()` or `resumeFork` calls (`SPEC.md` §3.7.2).
 *
 * Consolidates parent actor state, `BranchableScope`, `ScopeLockManager`, `StepContinuationQueue`,
 * `LedgerStore`, `LessonStore`, `ModelDriver`, and the child step runner callback.
 *
 * @template THandle Runtime handle type of the active `BranchableScope`.
 */
export interface ForkBatchExecutionParams<THandle = unknown> {
  /** Parent `AgentNode` dispatching the fork or `resumeFork` batch. */
  readonly parentNode: AgentNode<unknown, unknown, THandle>;
  /** Validated parent input payload. */
  readonly parentInput: unknown;
  /** Parent leaf message ID at the fork point. */
  readonly parentLeafMessageId: string | null;
  /** Parent `ContinuationFrame[]` prefixing the `ForkBatchContinuationFrame`. */
  readonly outerFrames: readonly ContinuationFrame[];
  /** Existing `ForkBatchContinuationFrame` when recovering or resuming mid-batch. */
  readonly existingBatchFrame?: ForkBatchContinuationFrame;
  /** Dispatched `.fork()` call items for `executeForkBatch`. */
  readonly forkCalls?: readonly ForkDispatchCallItem<THandle>[];
  /** Dispatched `resumeFork` request for `executeResumeForkBatch`. */
  readonly resumeRequest?: {
    readonly callId: string;
    readonly suspendedForkIds: readonly string[];
    readonly action: 'resume' | 'abort';
    readonly resolutionSummary: string;
  };
  /** Active `BranchableScope` driver. */
  readonly branchableScope: BranchableScope<THandle, Record<string, unknown>, Record<string, unknown>>;
  /** Shared-read / exclusive-write lock manager for `parentHandle`. */
  readonly lockManager: ScopeLockManager;
  /** Per-`stepExecId` serialized continuation stack queue. */
  readonly continuationQueue: StepContinuationQueue;
  /** Durable `LedgerStore` instance. */
  readonly ledgerStore: LedgerStore;
  /** Optional `LessonStore` for idempotent post-`CHILD_COMMITTED` outcome flushing. */
  readonly lessonStore?: LessonStore;
  /** Optional `PoolManager` for child `.modelRouting`. */
  readonly poolManager?: PoolManager;
  /** Optional `ModelDriver` for `prepareFork` and `appendToolResultNotes`. */
  readonly modelDriver?: ModelDriver;
  /** Optional pinned `CompiledWirePrefix` for the parent/child prefix group. */
  readonly wirePrefix?: CompiledWirePrefix;
  /** Optional map of `HumanAdapter` instances keyed by `humanNode.id` for `cancelDecision`. */
  readonly humanAdaptersById?: ReadonlyMap<string, HumanAdapter>;
  /** Step execution context of the parent actor (`ctx.scopeHandle` is `parentHandle`). */
  readonly ctx: StepExecutionContext<THandle>;
  /** Callback executing a child `AgentNode` or `LoopNode` on an isolated `childHandle`. */
  readonly executeChildStep: (
    childNode: StepASTNode<unknown, unknown, THandle>,
    childInput: unknown,
    childCtx: StepExecutionContext<THandle>,
  ) => Promise<ChildForkExecutionOutcome<unknown>>;
  /** Optional reference to result type for property reachability. */
  readonly resultTemplate?: ForkBatchExecutionResult;
  /** Optional reference to entry record for property reachability. */
  readonly entryTemplate?: ForkBatchEntryRecord;
  /** Optional reference to suspended fork record for property reachability. */
  readonly suspendedRecordTemplate?: SuspendedForkRecord;
  /** Optional reference to lease delta for property reachability. */
  readonly leaseTemplate?: LeaseDelta;
  /** Optional reference to reconcile params for property reachability. */
  readonly reconcileTemplate?: ReconcileChildForkParams<THandle>;
  /** Optional reference to pause sibling barrier context for property reachability. */
  readonly pauseSiblingTemplate?: PauseSiblingBarrierContext<THandle>;
  /** Optional reference to turn-batch barrier context for property reachability. */
  readonly barrierContextTemplate?: TurnBatchBarrierContext<THandle>;
  /** Optional reference to turn-batch barrier result for property reachability. */
  readonly barrierResultTemplate?: TurnBatchBarrierResult;
  /** Optional reference to resume entry params for property reachability. */
  readonly resumeEntryTemplate?: ResumeSuspendedForkEntryParams<THandle>;
}
