import type { ModelASTNode, StepASTNode } from '../../ast/domain-ast.types.js';
import type { AgentContinuationFrame } from '../../ports/agent-continuation-frame.js';
import type { BranchableScope } from '../../ports/branchable-scope.js';
import type { CompiledWirePrefix } from '../../ports/compiled-wire-prefix.js';
import type { ContinuationFrame } from '../../ports/continuation-frame.types.js';
import type { HumanAdapter } from '../../ports/human-adapter.js';
import type { LedgerStore } from '../../ports/ledger-store.js';
import type { LessonOutcome } from '../../ports/lesson-outcome.types.js';
import type { LessonStore } from '../../ports/lesson-store.js';
import type { LoopContinuationFrame } from '../../ports/loop-continuation-frame.js';
import type { StepExecutionContext } from '../../ports/step-execution-context.js';
import type { TopologyStore } from '../../ports/topology-store.js';
import type { ChildForkExecutionOutcome } from '../fork/child-fork-execution-outcome.js';
import type { ScopeLockManager } from '../locks/scope-lock-manager.js';
import type { StepContinuationQueue } from '../locks/step-continuation-queue.js';
import type { PoolManager } from '../pools/pool-manager.js';
import type { ServiceSessionRegistry } from '../services/service-session-registry.js';

/**
 * Mutable sink receiving a child agent or loop step's final continuation stack, leaf message ID, and lesson outcomes (`SPEC.md` §3.7.2 & §3.8).
 *
 * Read by parent `.fork()`, `.speculate()`, and `P.loop` orchestrators in `finally` blocks.
 */
export interface StepRuntimeChildOutcomeSink {
  /** Final or suspended continuation stack produced by the child step. */
  continuationStack?: readonly ContinuationFrame[];

  /** Final or preserved leaf message frame identifier. */
  leafMessageId?: string | null;

  /** Deduplicated per-lesson outcomes accumulated by the child step. */
  accumulatedLessonOutcomes?: Readonly<Record<string, LessonOutcome>>;

  /** Loop phase (`'act'` or `'evaluate'`) that raised an upward interrupt. */
  raisedByPhase?: 'act' | 'evaluate';

  /** Tool call ID at which the child step suspended. */
  suspendedAtCallId?: string;
}

/**
 * Mutable lane plan mutation tracking state attached to a step execution context (`SPEC.md` §3.7.2 Capability 3).
 *
 * Tracks spawned task counts and the linear prerequisite chain tip across `.mutatePlan()` tool calls.
 */
export interface StepRuntimePlanMutationContext {
  /** Enclosing lane identifier. */
  readonly laneId: string;

  /** Parent work item deduplication key. */
  readonly parentItemKey: string;

  /** Parent work item base priority level. */
  readonly parentPriority?: 'low' | 'normal' | 'high' | 'critical' | undefined;

  /** Cumulative number of tasks spawned by the current run so far. */
  previouslySpawnedCount: number;

  /** Item key of the most recently spawned prerequisite task in the current run. */
  previousSpawnedTipKey?: string;
}

/**
 * Internal runtime managers, stores, and continuation state attached to `StepExecutionContext._runtime` (`SPEC.md` §3.1–§3.10).
 *
 * Accessed via `getStepRuntimeInternals(ctx)` across agent, loop, fork, and speculate executors.
 *
 * @template THandle Runtime handle type of the active isolation scope.
 */
export interface StepRuntimeInternals<THandle = unknown> {
  /** Durable execution ledger store. */
  readonly ledgerStore?: LedgerStore;

  /** Partition contract topology store. */
  readonly topologyStore?: TopologyStore;

  /** Institutional memory lesson store. */
  readonly lessonStore?: LessonStore;

  /** Per-handle shared-read / exclusive-write lock manager. */
  readonly lockManager?: ScopeLockManager;

  /** Per-step serialized `ContinuationFrame[]` update queue. */
  readonly continuationQueue?: StepContinuationQueue;

  /** Capacity pool manager for models, seats, and warm containers. */
  readonly poolManager?: PoolManager;

  /** Reference-counted background daemon session registry. */
  readonly serviceRegistry?: ServiceSessionRegistry;

  /** Human escalation and notification adapters keyed by `humanNode.id`. */
  readonly humanAdaptersById?: ReadonlyMap<string, HumanAdapter>;

  /** Pre-compiled immutable wire prefixes keyed by `prefixGroup.id`. */
  readonly wirePrefixesByGroupId?: ReadonlyMap<string, CompiledWirePrefix>;

  /** Pre-compiled immutable wire prefix directly bound to the current actor. */
  readonly wirePrefix?: CompiledWirePrefix;

  /** Active Tier-3 branchable scope driver. */
  readonly branchableScope?: BranchableScope<THandle>;

  /** Enclosing outer continuation frames (`LoopContinuationFrame`, `ForkBatchContinuationFrame`, `SpeculateContinuationFrame`). */
  readonly outerFrames?: ContinuationFrame[];

  /** Pre-loaded `AgentContinuationFrame` when resuming an interrupted agent turn. */
  readonly existingAgentFrame?: AgentContinuationFrame;

  /** Pre-loaded `LoopContinuationFrame` when resuming an interrupted loop step. */
  readonly existingLoopFrame?: LoopContinuationFrame;

  /** Escalated model AST node overriding `agentNode.model` during loop retries. */
  readonly overrideModelNode?: ModelASTNode;

  /** True when resuming a Case C (`GATE_BOUNDARY`) fork after a neutral topology sync. */
  readonly neutralSyncContinuation?: boolean;

  /** Custom child step executor callback for nested adjudicators, replacements, and forks. */
  readonly executeChildStep?: (
    childNode: StepASTNode<unknown, unknown, THandle>,
    childInput: unknown,
    childCtx: StepExecutionContext<THandle>,
  ) => Promise<ChildForkExecutionOutcome<unknown>>;

  /** Optional enclosing lane identifier for `.mutatePlan()`. */
  readonly laneId?: string;

  /** Optional enclosing work item key for `.mutatePlan()`. */
  readonly itemKey?: string;

  /** Optional base scope checkpoint captured at step start. */
  readonly baseScopeCheckpoint?: string;

  /** Mutable lane plan mutation state for `.mutatePlan()` tool calls. */
  readonly planMutationContext?: StepRuntimePlanMutationContext;

  /** Mutable sink populated on child step exit with continuation frames and lesson outcomes. */
  readonly childOutcomeSink?: StepRuntimeChildOutcomeSink;

  /** Optional callback folding flow-scoped `ToolEffect[]` through `flow.telemetry` (`SPEC.md` §3.9). */
  readonly collectCustomTelemetry?: () => Promise<Readonly<Record<string, unknown>>>;
}
