import type { MutatePlanCapabilityNode } from '../../ast/mutate-plan-capability-node.js';
import type { AgentContinuationFrame } from '../../ports/agent-continuation-frame.js';
import type { BranchableScope } from '../../ports/branchable-scope.js';
import type { CheckpointableScope } from '../../ports/checkpointable-scope.js';
import type { ContinuationFrame } from '../../ports/continuation-frame.types.js';
import type { LeaseDelta } from '../../ports/lease-delta.js';
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
 * Outcome returned by `executeSpawnTasks()` or `executeAddDependencies()`.
 *
 * Indicates the chained prerequisite keys, updated `previousSpawnedTipKey`, and whether the parent step suspended.
 */
export interface PlanMutationResult {
  /** Ordered work item keys of the spawned or linked prerequisites. */
  readonly prerequisiteItemKeys: readonly string[];
  /** Tip item key of the linear prerequisite chain ($T_k$). */
  readonly latestTipItemKey: string | undefined;
  /** True when the parent step transitioned to `'SUSPENDED'` (`onPrerequisiteSpawned: 'suspend-and-yield-slot'`). */
  readonly suspended: boolean;
  /** Optional `headScopeCheckpoint` captured prior to yielding the concurrency slot. */
  readonly headScopeCheckpoint?: string;
  /** Serialized tool result string to record in `completedResults`. */
  readonly toolResultText: string;
}

/**
 * Parameters for `syncSuspendedRunPrerequisites()` during `'SUSPENDED'` wakeup or initial `QUEUED -> RUNNING` start.
 *
 * Supplies the prerequisite item keys, `LedgerStore`, optional `TopologyStore`, `BranchableScope`,
 * `ServiceSessionRegistry`, and active `AgentContinuationFrame`.
 *
 * @template THandle Runtime handle type of the active isolation scope.
 */
export interface SyncPrerequisitesParams<THandle = unknown> {
  /** Enclosing flow run identifier. */
  readonly runId: string;
  /** Active step execution identifier. */
  readonly stepExecId: string;
  /** Prerequisite work item keys to synchronize against. */
  readonly prerequisiteItemKeys: readonly string[];
  /** Optional prerequisite run IDs for `TopologyStore.syncRunOverlays()`. */
  readonly prerequisiteRunIds?: readonly string[];
  /** Optional persisted `headScopeCheckpoint` restored before `syncRoot` on replay-idempotent wakeup. */
  readonly headScopeCheckpoint?: string;
  /** Active `AgentContinuationFrame` when resuming a suspended step, or `undefined` on initial run start. */
  readonly agentFrame?: AgentContinuationFrame;
  /** Outer continuation frames prefixing `agentFrame`. */
  readonly outerFrames?: readonly ContinuationFrame[];
  /** Durable `LedgerStore` queried for terminal receipts and updated with `syncedToPrerequisiteCheckpoint`. */
  readonly ledgerStore: LedgerStore;
  /** Optional `StepContinuationQueue` serializing continuation stack updates. */
  readonly continuationQueue?: StepContinuationQueue;
  /** Optional `TopologyStore` absorbing prerequisite run overlays. */
  readonly topologyStore?: TopologyStore;
  /** Optional `BranchableScope` executing `restoreCheckpoint` and `syncRoot`. */
  readonly branchableScope?: BranchableScope<THandle, Record<string, unknown>, Record<string, unknown>>;
  /** Optional `ServiceSessionRegistry` re-acquiring active skill services after `syncedToPrerequisiteCheckpoint`. */
  readonly serviceRegistry?: ServiceSessionRegistry;
  /** Active isolation scope handle. */
  readonly scopeHandle: THandle;
}

/**
 * Outcome returned by `syncSuspendedRunPrerequisites()` after synchronizing prerequisite receipts and overlays.
 *
 * Carries formatted synchronization notes (`[PREREQUISITE_SYNC]`, `[PREREQUISITE_FAILED]`, `[SERVICE_REACQUIRED]`),
 * any conflict resolution lease, and the updated `AgentContinuationFrame`.
 */
export interface SyncPrerequisitesResult {
  /** True when all prerequisites completed cleanly in an allowed exit state. */
  readonly allPrerequisitesSucceeded: boolean;
  /** Synchronization note strings to append to the transcript before draining `remainingCalls`. */
  readonly syncNotes: readonly string[];
  /** Optional conflict resolution lease granted when `syncRoot` returned `status: 'conflict'`. */
  readonly conflictLease?: LeaseDelta;
  /** Whether `conflictCleanCheck` was armed by a conflicted `syncRoot`. */
  readonly conflictCheckArmed: boolean;
  /** Updated `AgentContinuationFrame` with `syncedToPrerequisiteCheckpoint` persisted. */
  readonly updatedAgentFrame?: AgentContinuationFrame;
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
  /** Optional reference to result type for property reachability. */
  readonly resultTemplate?: PlanMutationResult;
  /** Optional reference to sync params type for property reachability. */
  readonly syncParamsTemplate?: SyncPrerequisitesParams<THandle>;
  /** Optional reference to sync result type for property reachability. */
  readonly syncResultTemplate?: SyncPrerequisitesResult;
}
