import type { ScopeRewindHookASTNode, StepASTNode } from '../../ast/domain-ast.types.js';
import type { FlowNode } from '../../ast/flow-node.js';
import type { PrefixGroupNode } from '../../ast/prefix-group-node.js';
import type { CheckpointableScope } from '../../ports/checkpointable-scope.js';
import type { CompiledWirePrefix } from '../../ports/compiled-wire-prefix.js';
import type { HumanAdapter } from '../../ports/human-adapter.js';
import type { InterruptedStepRecord } from '../../ports/interrupted-step-record.js';
import type { IsolationScope } from '../../ports/isolation-scope.js';
import type { LedgerStore } from '../../ports/ledger-store.js';
import type { LessonStore } from '../../ports/lesson-store.js';
import type { RuntimeExecutorRegistry } from '../../ports/runtime-executor-registry.js';
import type { ToolEffect } from '../../ports/tool-effect.js';
import type { TopologyStore } from '../../ports/topology-store.js';
import type { ScopeLockManager } from '../locks/scope-lock-manager.js';
import type { StepContinuationQueue } from '../locks/step-continuation-queue.js';
import type { PoolManager } from '../pools/pool-manager.js';
import type { ServiceSessionRegistry } from '../services/service-session-registry.js';

/**
 * Parameters for promoting an interrupted step to a `.replaceWith()` replacement executable (`SPEC.md` §3.6 & §3.9).
 *
 * Supplies the flow execution context, interrupted step coordinates, replacement executable AST node,
 * and replacement flow input.
 *
 * @template TIn     Validated flow input payload type.
 * @template THandle Runtime handle type of the active isolation scope.
 */
export interface ReplaceWithPromotionParams<TIn = unknown, THandle = unknown> {
  /** Active flow execution context. */
  readonly flowCtx: FlowExecutionContext<TIn, THandle>;
  /** Interrupted `stepExecId` being replaced. */
  readonly stepExecId: string;
  /** Enclosing `FlowStepNode.id` being replaced. */
  readonly stepId: string;
  /** Base scope checkpoint serialized when the step started, if any. */
  readonly baseScopeCheckpoint?: string;
  /** Replacement executable AST node (`AgentNode`, `LoopNode`, `CommandNode`, or domain step). */
  readonly replacementExecutable: StepASTNode<unknown, unknown, THandle>;
  /** Updated flow input payload produced by `replaceWith.mapInput`. */
  readonly replacementInput: TIn;
  /** Optional abort hook metadata JSON persisted during `.onLimitExceeded()` or `.replaceWith()`. */
  readonly abortMetaJson?: string;
}

/**
 * Parameters for executing the 4-step Hierarchical Rewind Drain Barrier (`SPEC.md` §3.10).
 *
 * Supplies the flow execution context, target `rewindToStepId`, updated flow input, and optional
 * `onRewind` scope hook.
 *
 * @template TIn     Validated flow input payload type.
 * @template THandle Runtime handle type of the active isolation scope.
 */
export interface HierarchicalRewindDrainParams<TIn = unknown, THandle = unknown> {
  /** Active flow execution context. */
  readonly flowCtx: FlowExecutionContext<TIn, THandle>;
  /** Target step or branch ID in `flow.nodes` to rewind execution to (or `null` when cancelling). */
  readonly rewindToStepId: string | null;
  /** Updated flow input payload produced by `onSignal.updateMapper`. */
  readonly updatedInput: TIn;
  /** Optional scope rewind hook executed during Step 4 of the drain barrier. */
  readonly onRewindHook?: ScopeRewindHookASTNode<THandle>;
  /** Terminal status recorded on the interrupted active step (`'INTERRUPTED'` or `'CANCELLED'`). */
  readonly stepTerminalStatus?: 'INTERRUPTED' | 'CANCELLED';
}

/**
 * Parameters for recovering a non-terminal run returned by `LedgerStore.getInterruptedStepsOnBoot()` (`SPEC.md` §3.10).
 *
 * Supplies the boot record, bound `FlowNode`, and runtime stores/managers needed to reattach
 * root and child scopes and resume mid-step state machines.
 *
 * @template TIn     Validated flow input payload type.
 * @template THandle Runtime handle type of the active isolation scope.
 */
export interface RecoverInterruptedRunParams<TIn = unknown, THandle = unknown> {
  /** Non-terminal step boot record loaded from `LedgerStore.getInterruptedStepsOnBoot()`. */
  readonly bootRecord: InterruptedStepRecord;
  /** Bound `FlowNode` definition for the run's lane. */
  readonly flow: FlowNode<TIn, THandle>;
  /** Active flow execution context configured for the recovered run. */
  readonly flowCtx: FlowExecutionContext<TIn, THandle>;
}

/**
 * Terminal outcome returned by `executeFlow()` (`SPEC.md` §3.9).
 *
 * Captures the terminal exit state, final scope receipt, completed step outputs, and folded
 * custom telemetry metrics.
 */
export interface FlowRunResult {
  /** Identifier of the flow run. */
  readonly runId: string;
  /** Terminal exit state string (`flow.exitState`, `'SUSPENDED'`, or failure state). */
  readonly exitState: string;
  /** Final scope receipt (`TReceipt`) inspected before releasing the root scope. */
  readonly scopeReceipt: Record<string, unknown>;
  /** Map of completed `stepId` (or outer `branchStepId`) to its validated output value. */
  readonly stepOutputs: Readonly<Record<string, unknown>>;
  /** Custom telemetry metrics folded by `flow.telemetry`, if configured. */
  readonly customTelemetry?: Readonly<Record<string, unknown>>;
}

/**
 * Mutable runtime state and dependency context for executing a single `FlowNode` run (`SPEC.md` §3.9).
 *
 * Holds the root `scopeHandle`, `completedStepOutputs` map, pinned wire prefixes, `AbortController`
 * for active step drain barriers, and runtime store/manager references.
 *
 * @template TIn     Validated flow input payload type.
 * @template THandle Runtime handle type of the active isolation scope.
 */
export interface FlowExecutionContext<TIn = unknown, THandle = unknown> {
  /** Unique identifier of the flow run. */
  readonly runId: string;
  /** Identifier of the enclosing `LaneNode` (defaults to `'default-lane'`). */
  readonly laneId: string;
  /** Deduplication key (`itemKey`) of the work item. */
  readonly itemKey: string;
  /** Passive `FlowNode` AST definition being executed. */
  readonly flow: FlowNode<TIn, THandle>;
  /** Latest validated flow input payload (mutable across `.replaceWith()` and `.onSignal().update()`). */
  currentInput: TIn;
  /** Active root isolation scope handle for the run. */
  scopeHandle: THandle;
  /** Resolved `IsolationScope` (and optional `CheckpointableScope` / `BranchableScope`) driver. */
  readonly scopeDriver: IsolationScope<THandle> & Partial<CheckpointableScope<THandle>>;
  /** Composite runtime executor registry. */
  readonly registry: RuntimeExecutorRegistry;
  /** Explicit environment variable map for resolving symbolic `H.env(key)` references. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Durable state ledger store. */
  readonly ledgerStore: LedgerStore;
  /** Optional topology store for run-scoped partition contract overlays. */
  readonly topologyStore?: TopologyStore;
  /** Optional lesson store for empirical lesson recall and outcome attribution. */
  readonly lessonStore?: LessonStore;
  /** Per-handle read/write lock manager. */
  readonly lockManager: ScopeLockManager;
  /** Per-`stepExecId` continuation stack serialization queue. */
  readonly continuationQueue: StepContinuationQueue;
  /** Stateful pool manager for model and account seat selection. */
  readonly poolManager: PoolManager;
  /** Lifecycle registry for `'scope'`, `'fork'`, and `'skill'` `ServiceSession` daemons. */
  readonly serviceRegistry: ServiceSessionRegistry;
  /** Map of `HumanNode.id` to runtime `HumanAdapter`. */
  readonly humanAdaptersById: ReadonlyMap<string, HumanAdapter>;
  /** Optional prefix groups to compile and pin at run start. */
  readonly prefixGroups?: readonly PrefixGroupNode[];
  /** Pinned `CompiledWirePrefix` records keyed by `PrefixGroupNode.id`. */
  wirePrefixesByGroupId: ReadonlyMap<string, CompiledWirePrefix>;
  /** Completed step outputs keyed by `FlowStepNode.id` or outer `FlowBranchNode.id`. */
  readonly completedStepOutputs: Map<string, unknown>;
  /** Accumulated `ToolEffect` entries observed across all steps in the flow run. */
  readonly observedRunEffects: ToolEffect[];
  /** Currently executing `stepId` (or `null` between steps). */
  activeStepId: string | null;
  /** Currently executing `stepExecId` (or `null` between steps). */
  activeStepExecId: string | null;
  /** Currently executing replacement `StepASTNode` promoted via `.replaceWith()`, if any. */
  activeReplacementExecutable?: StepASTNode<unknown, unknown, THandle>;
  /** `AbortController` governing the currently executing step for rewind/cancel drain barriers. */
  activeStepAbortController: AbortController;
  /** Target `stepId` queued by `.rewindTo()` to jump the flow loop to after draining. */
  pendingRewindToStepId?: string;
  /** Optional step retry configuration inherited from the enclosing `LaneNode`. */
  readonly retryConfig?: {
    readonly tries: number;
    readonly exponentialBaseMs: number;
    readonly orFailState: string;
  };
  /** Optional reference to replace-with promotion parameters for property reachability. */
  readonly replacePromotionTemplate?: ReplaceWithPromotionParams<TIn, THandle>;
  /** Optional reference to hierarchical rewind drain parameters for property reachability. */
  readonly rewindDrainTemplate?: HierarchicalRewindDrainParams<TIn, THandle>;
  /** Optional reference to crash recovery parameters for property reachability. */
  readonly recoveryTemplate?: RecoverInterruptedRunParams<TIn, THandle>;
  /** Optional reference to flow run result for property reachability. */
  readonly runResultTemplate?: FlowRunResult;
}
