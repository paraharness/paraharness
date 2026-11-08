import type { StepASTNode } from '../../ast/domain-ast.types.js';
import type { FlowNode } from '../../ast/flow-node.js';
import type { PrefixGroupNode } from '../../ast/prefix-group-node.js';
import type { CheckpointableScope } from '../../ports/checkpointable-scope.js';
import type { CompiledWirePrefix } from '../../ports/compiled-wire-prefix.js';
import type { ContinuationFrame } from '../../ports/continuation-frame.types.js';
import type { HumanAdapter } from '../../ports/human-adapter.js';
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
  /** Explicit environment variable map for resolving symbolic `P.env(key)` references. */
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
  /** Optional map of initial base scope checkpoints keyed by `FlowStepNode.id`. */
  readonly stepBaseCheckpointsByStepId?: Map<string, string>;
  /** Accumulated `ToolEffect` entries observed across all steps in the flow run. */
  readonly observedRunEffects: ToolEffect[];
  /** Currently executing `stepId` (or `null` between steps). */
  activeStepId: string | null;
  /** Currently executing `stepExecId` (or `null` between steps). */
  activeStepExecId: string | null;
  /** Currently executing replacement `StepASTNode` promoted via `.replaceWith()`, if any. */
  activeReplacementExecutable?: StepASTNode<unknown, unknown, THandle>;
  /** Persisted continuation stack restored during reboot recovery for the first resumed step execution. */
  resumeContinuationStack?: readonly ContinuationFrame[];
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
}
