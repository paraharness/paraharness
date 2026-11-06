import type { MutatePlanCapabilityNode } from '../../ast/mutate-plan-capability-node.js';
import type { AgentContinuationFrame } from '../../ports/agent-continuation-frame.js';
import type { CheckpointableScope } from '../../ports/checkpointable-scope.js';
import type { ContinuationFrame } from '../../ports/continuation-frame.types.js';
import type { LedgerStore } from '../../ports/ledger-store.js';
import type { PendingToolBatch } from '../../ports/pending-tool-batch.js';
import type { StepExecutionContext } from '../../ports/step-execution-context.js';
import type { TopologyStore } from '../../ports/topology-store.js';
import type { StepContinuationQueue } from '../locks/step-continuation-queue.js';
import type { ServiceSessionRegistry } from '../services/service-session-registry.js';

/**
 * Raw task descriptor supplied to `executeSpawnTasks()`.
 *
 * Carries an optional explicit `itemKey`, raw `item` payload, and optional extra `dependsOn` keys.
 */
export interface SpawnTaskInputEntry {
  /** Optional explicit work item deduplication key (extracted or generated when omitted). */
  readonly itemKey?: string;
  /** Raw work item payload validated against `spawnTasks.itemSchema`. */
  readonly item: unknown;
  /** Optional additional prerequisite item keys beyond the linear stacking chain. */
  readonly dependsOn?: readonly string[];
}

/**
 * Parameters for executing `.mutatePlan()` capability tools (`spawnTasks`, `addDependencies`, `updatePartitionContract`).
 *
 * Consolidates the `MutatePlanCapabilityNode`, lane/run coordinates, stores, scope, and continuation state.
 *
 * @template THandle Runtime handle type of the active isolation scope.
 */
export interface PlanMutationParams<THandle = unknown> {
  /** Passive `.mutatePlan()` capability AST node. */
  readonly mutatePlanNode: MutatePlanCapabilityNode<unknown>;
  /** Identifier of the enclosing `LaneNode`. */
  readonly laneId: string;
  /** Work item deduplication key of the parent run. */
  readonly parentItemKey: string;
  /** Priority level of the parent run (`'low' | 'normal' | 'high' | 'critical'`). */
  readonly parentPriority?: 'low' | 'normal' | 'high' | 'critical';
  /** Number of tasks already spawned by this run so far. */
  readonly previouslySpawnedCount?: number;
  /** Item key of the most recently spawned prerequisite tip ($T_{\text{prevTip}}$) for linear chaining. */
  readonly previousSpawnedTipKey?: string;
  /** Spawned task entries when invoking `spawnTasks`. */
  readonly tasksToSpawn?: readonly SpawnTaskInputEntry[];
  /** Existing prerequisite item keys when invoking `addDependencies`. */
  readonly dependencyKeysToAdd?: readonly string[];
  /** Partition contract update payload when invoking `updatePartitionContract`. */
  readonly contractUpdate?: { readonly partitionId: string; readonly newContractText: string };
  /** Active `AgentContinuationFrame` when invoked from an agent tool call. */
  readonly agentFrame?: AgentContinuationFrame;
  /** Outer continuation frames prefixing `agentFrame`. */
  readonly outerFrames?: readonly ContinuationFrame[];
  /** Pending tool batch saved inside `PrerequisiteWaitPauseState` when suspending. */
  readonly pendingToolBatch?: PendingToolBatch;
  /** Durable `LedgerStore` instance. */
  readonly ledgerStore: LedgerStore;
  /** Optional `StepContinuationQueue` serializing continuation updates. */
  readonly continuationQueue?: StepContinuationQueue;
  /** Optional `TopologyStore` instance for `updatePartitionContract`. */
  readonly topologyStore?: TopologyStore;
  /** Optional `ServiceSessionRegistry` quiesced when suspending. */
  readonly serviceRegistry?: ServiceSessionRegistry;
  /** Optional `CheckpointableScope` used to snapshot `headScopeCheckpoint` on suspension. */
  readonly checkpointScope?: CheckpointableScope<THandle, Record<string, unknown>>;
  /** Step execution context. */
  readonly ctx: StepExecutionContext<THandle>;
}
