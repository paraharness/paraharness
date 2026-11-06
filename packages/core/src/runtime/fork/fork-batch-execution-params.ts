import type { AgentNode } from '../../ast/agent-node.js';
import type { StepASTNode } from '../../ast/domain-ast.types.js';
import type { ForkCapabilityNode } from '../../ast/fork-capability-node.js';
import type { BranchableScope } from '../../ports/branchable-scope.js';
import type { CompiledWirePrefix } from '../../ports/compiled-wire-prefix.js';
import type { ContinuationFrame } from '../../ports/continuation-frame.types.js';
import type { ForkBatchContinuationFrame } from '../../ports/fork-batch-continuation-frame.js';
import type { PrecedingCompletedToolResult } from '../../ports/fork-context.js';
import type { HumanAdapter } from '../../ports/human-adapter.js';
import type { LedgerStore } from '../../ports/ledger-store.js';
import type { LessonStore } from '../../ports/lesson-store.js';
import type { ModelDriver } from '../../ports/model-driver.js';
import type { StepExecutionContext } from '../../ports/step-execution-context.js';
import type { ScopeLockManager } from '../locks/scope-lock-manager.js';
import type { StepContinuationQueue } from '../locks/step-continuation-queue.js';
import type { PoolManager } from '../pools/pool-manager.js';
import type { ChildForkExecutionOutcome } from './child-fork-execution-outcome.js';

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
  /** Preceding completed tool results in the same assistant turn batch forwarded to `prepareFork`. */
  readonly precedingCompletedResults?: readonly PrecedingCompletedToolResult[];
  /** Sibling fork `callId`s in the same assistant turn batch forwarded to `prepareFork`. */
  readonly siblingForkCallIds?: readonly string[];
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
  /** Optional callback executing a child `AgentNode` or `LoopNode` on an isolated `childHandle`. */
  readonly executeChildStep?: (
    childNode: StepASTNode<unknown, unknown, THandle>,
    childInput: unknown,
    childCtx: StepExecutionContext<THandle>,
  ) => Promise<ChildForkExecutionOutcome<unknown>>;
}
