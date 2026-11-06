import type { AgentNode } from '../../ast/agent-node.js';
import type { StepASTNode } from '../../ast/domain-ast.types.js';
import type { SpeculateCapabilityNode } from '../../ast/speculate-capability-node.js';
import type { BranchableScope } from '../../ports/branchable-scope.js';
import type { CompiledWirePrefix } from '../../ports/compiled-wire-prefix.js';
import type { ContinuationFrame } from '../../ports/continuation-frame.types.js';
import type { HumanAdapter } from '../../ports/human-adapter.js';
import type { LedgerStore } from '../../ports/ledger-store.js';
import type { LessonStore } from '../../ports/lesson-store.js';
import type { ModelDriver } from '../../ports/model-driver.js';
import type { SpeculateContinuationFrame } from '../../ports/speculate-continuation-frame.js';
import type { StepExecutionContext } from '../../ports/step-execution-context.js';
import type { ChildForkExecutionOutcome } from '../fork/child-fork-execution-outcome.js';
import type { ScopeLockManager } from '../locks/scope-lock-manager.js';
import type { StepContinuationQueue } from '../locks/step-continuation-queue.js';

/**
 * Parameters for executing a parallel `.speculate()` tournament (`SPEC.md` §3.7.2 Capability 2).
 *
 * Consolidates the `SpeculateCapabilityNode`, parent state, `BranchableScope`, `ScopeLockManager`,
 * `StepContinuationQueue`, `LedgerStore`, `LessonStore`, `HumanAdapter` map, and step runner callback.
 *
 * @template THandle Runtime handle type of the active `BranchableScope`.
 */
export interface SpeculateTournamentParams<THandle = unknown> {
  /** Parent `AgentNode` launching the tournament. */
  readonly parentNode: AgentNode<unknown, unknown, THandle>;
  /** Validated parent input payload. */
  readonly parentInput: unknown;
  /** Wire-level tool `callId` of the `.speculate()` invocation. */
  readonly callId: string;
  /** Matched `SpeculateCapabilityNode`. */
  readonly capability: SpeculateCapabilityNode<
    unknown,
    unknown,
    unknown,
    unknown,
    THandle,
    unknown,
    unknown
  >;
  /** Raw JSON arguments passed to the `.speculate()` tool call. */
  readonly argsJson: string;
  /** Outer continuation frames prefixing `SpeculateContinuationFrame`. */
  readonly outerFrames: readonly ContinuationFrame[];
  /** Optional existing `SpeculateContinuationFrame` when recovering mid-tournament. */
  readonly existingTournamentFrame?: SpeculateContinuationFrame;
  /** Active `BranchableScope` driver. */
  readonly branchableScope: BranchableScope<THandle, Record<string, unknown>, Record<string, unknown>>;
  /** Shared-read / exclusive-write lock manager for `parentHandle`. */
  readonly lockManager: ScopeLockManager;
  /** Per-`stepExecId` serialized continuation stack queue. */
  readonly continuationQueue: StepContinuationQueue;
  /** Durable `LedgerStore` instance. */
  readonly ledgerStore: LedgerStore;
  /** Optional `LessonStore` flushed strictly for the winning branch after `WINNER_COMMITTED`. */
  readonly lessonStore?: LessonStore;
  /** Optional `ModelDriver` used for conflict-bounce note injection. */
  readonly modelDriver?: ModelDriver;
  /** Optional pinned `CompiledWirePrefix`. */
  readonly wirePrefix?: CompiledWirePrefix;
  /** Map of `HumanAdapter` instances keyed by `humanNode.id` for `'unpark-escalation'`. */
  readonly humanAdaptersById?: ReadonlyMap<string, HumanAdapter>;
  /** Step execution context of the parent actor (`ctx.scopeHandle` is `parentHandle`). */
  readonly ctx: StepExecutionContext<THandle>;
  /** Optional callback executing a branch worker, sole-survivor evaluator, arbiter, or refinement step. */
  readonly executeChildStep?: (
    childNode: StepASTNode<unknown, unknown, THandle>,
    childInput: unknown,
    childCtx: StepExecutionContext<THandle>,
  ) => Promise<ChildForkExecutionOutcome<unknown>>;
}
