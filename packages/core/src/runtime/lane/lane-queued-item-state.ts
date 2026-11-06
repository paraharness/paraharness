import type { LaneNode } from '../../ast/lane-node.js';
import type { PrefixGroupNode } from '../../ast/prefix-group-node.js';
import type { TopologyNode } from '../../ast/topology-node.js';
import type { HumanAdapter } from '../../ports/human-adapter.js';
import type { LedgerStore } from '../../ports/ledger-store.js';
import type { LessonStore } from '../../ports/lesson-store.js';
import type { RuntimeExecutorRegistry } from '../../ports/runtime-executor-registry.js';
import type { TopologyStore } from '../../ports/topology-store.js';
import type { TrackerAdapter } from '../../ports/tracker-adapter.js';
import type { FlowExecutionContext } from '../flow/flow-execution-context.js';
import type { ScopeLockManager } from '../locks/scope-lock-manager.js';
import type { StepContinuationQueue } from '../locks/step-continuation-queue.js';
import type { PoolManager } from '../pools/pool-manager.js';
import type { ServiceSessionRegistry } from '../services/service-session-registry.js';

/**
 * Configuration dependencies injected into `LaneScheduler` at construction time (`SPEC.md` §3.10).
 *
 * Supplies the `LaneNode` AST, runtime executor registry, durable stores, and optional tracker/topology hooks.
 *
 * @template TIn Validated lane work item input type.
 */
export interface LaneSchedulerConfig<TIn = unknown> {
  /** Passive `LaneNode` AST definition governed by this scheduler. */
  readonly lane: LaneNode<TIn, string>;
  /** Composite runtime executor registry. */
  readonly registry: RuntimeExecutorRegistry;
  /** Explicit environment variable map for resolving symbolic `H.env(key)` references. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Durable state ledger store. */
  readonly ledgerStore: LedgerStore;
  /** Optional topology store for run-scoped partition contract overlays. */
  readonly topologyStore?: TopologyStore;
  /** Optional declarative `TopologyNode` AST for `commitOverlayWhen` correlation. */
  readonly topologyNode?: TopologyNode<string>;
  /** Optional lesson store for empirical lesson recall and outcome attribution. */
  readonly lessonStore?: LessonStore;
  /** Per-handle read/write lock manager. */
  readonly lockManager?: ScopeLockManager;
  /** Per-`stepExecId` continuation stack serialization queue. */
  readonly continuationQueue?: StepContinuationQueue;
  /** Stateful pool manager for model and account seat selection. */
  readonly poolManager?: PoolManager;
  /** Lifecycle registry for `'scope'`, `'fork'`, and `'skill'` `ServiceSession` daemons. */
  readonly serviceRegistry?: ServiceSessionRegistry;
  /** Map of `HumanNode.id` to runtime `HumanAdapter`. */
  readonly humanAdaptersById?: ReadonlyMap<string, HumanAdapter>;
  /** Optional tracker adapter instance overriding registry lookup. */
  readonly trackerAdapter?: TrackerAdapter<unknown, string>;
  /** Optional prefix groups to compile and pin at run start. */
  readonly prefixGroups?: readonly PrefixGroupNode[];
}

/**
 * Parameters for enqueuing a work item into `LaneScheduler.enqueueItem()` (`SPEC.md` §3.10).
 *
 * Allows overriding `enqueuedAtMs`, `priorityBoost`, and explicit `dependsOn` keys (such as from `spawnTasks`).
 *
 * @template TIn Validated lane work item input type.
 */
export interface EnqueueLaneItemOptions<TIn = unknown> {
  /** Raw or pre-validated work item input payload. */
  readonly input: TIn;
  /** Optional explicit run ID override (defaults to `"run:${laneId}:${itemKey}"`). */
  readonly runId?: string;
  /** Optional enqueue timestamp in milliseconds (defaults to `Date.now()`). */
  readonly enqueuedAtMs?: number;
  /** Optional priority boost inherited from a suspended parent (`'inherit-parent-with-boost'`). */
  readonly priorityBoost?: number;
  /** Optional explicit prerequisite item keys supplementing `lane.waitFor.depsMapper`. */
  readonly additionalDeps?: readonly string[];
}

/**
 * In-memory scheduling record for a work item tracked by `LaneScheduler` (`SPEC.md` §3.10).
 *
 * Tracks the item's lifecycle status, prerequisite `dependsOn` keys, cumulative USD cost,
 * approved budget ceiling, and active `FlowExecutionContext` when running.
 *
 * @template TIn Validated lane work item input type.
 */
export interface LaneQueuedItemState<TIn = unknown> {
  /** Unique run identifier (`runId`). */
  readonly runId: string;
  /** Deduplication key (`itemKey`) returned by `lane.keyMapper(input)`. */
  readonly itemKey: string;
  /** Enclosing `LaneNode.id`. */
  readonly laneId: string;
  /** Latest validated work item input payload. */
  input: TIn;
  /** Current lifecycle status of the item inside the lane. */
  status: 'QUEUED' | 'WAITING' | 'RUNNING' | 'SUSPENDED' | 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'ABANDONED';
  /** Terminal exit state label (`flow.exitState`, `waitFor.onAbandonedState`, `retry.orFailState`, or `'cancelled'`). */
  terminalExitState?: string;
  /** Epoch milliseconds when the item was enqueued. */
  readonly enqueuedAtMs: number;
  /** Additional priority weight boost (`'inherit-parent-with-boost'`). */
  priorityBoost: number;
  /** Prerequisite item keys (`itemKey`s) that must exit `'done'` before this item starts or resumes. */
  dependsOn: readonly string[];
  /** Cumulative USD cost accrued by the run. */
  costUsd: number;
  /** Effective USD budget ceiling (initially `lane.maxCostUsd?.limitUsd`, updated on human approval). */
  approvedMaxCostUsd?: number;
  /** Final scope receipt (`TReceipt`) captured when the run completed or sealed. */
  scopeReceipt?: Record<string, unknown>;
  /** Active `FlowExecutionContext` while the run is executing. */
  activeFlowCtx?: FlowExecutionContext<TIn, unknown>;
  /** Optional reference to scheduler configuration for property reachability. */
  readonly configTemplate?: LaneSchedulerConfig<TIn>;
  /** Optional reference to enqueue options for property reachability. */
  readonly enqueueOptionsTemplate?: EnqueueLaneItemOptions<TIn>;
}
