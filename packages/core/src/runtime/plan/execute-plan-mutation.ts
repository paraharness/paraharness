import { Graph, alg } from '@dagrejs/graphlib';
import type { AgentContinuationFrame } from '../../ports/agent-continuation-frame.js';
import type { ContinuationFrame } from '../../ports/continuation-frame.types.js';
import type { LeaseDelta } from '../../ports/lease-delta.js';
import type { LoopContinuationFrame } from '../../ports/loop-continuation-frame.js';
import type { MutateLanePlanSpawnedItem } from '../../ports/mutate-lane-plan-request.js';
import type { UniversalStepTelemetry } from '../../ports/universal-step-telemetry.js';
import { getStepRuntimeInternals } from '../agent/internal/get-step-runtime-internals.js';
import type { PlanMutationParams } from './plan-mutation-params.js';
import type { PlanMutationResult } from './plan-mutation-result.js';
import type { SyncPrerequisitesParams } from './sync-prerequisites-params.js';
import type { SyncPrerequisitesResult } from './sync-prerequisites-result.js';

/**
 * Quiesces scope services, serializes `headScopeCheckpoint`, and persists `'SUSPENDED'` step state (`SPEC.md` §3.7.2).
 *
 * Updates the parent step's `ContinuationFrame` stack with `pauseState.kind === 'prerequisite-wait'`
 * and records `'SUSPENDED'` in `LedgerStore`.
 *
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {PlanMutationParams<THandle>} params - Plan mutation parameters.
 *
 * @returns {Promise<string | undefined>} Serialized `headScopeCheckpoint`, if a `CheckpointableScope` is mounted.
 */
async function suspendParentStepForPrerequisites<THandle = unknown>(
  params: PlanMutationParams<THandle>,
): Promise<string | undefined> {
  await params.serviceRegistry?.quiesceScopeServices();
  const headCkpt =
    params.checkpointScope !== undefined
      ? await params.checkpointScope.serializeCheckpoint(params.ctx.scopeHandle)
      : undefined;
  if (params.agentFrame !== undefined && params.pendingToolBatch !== undefined) {
    const suspendedFrame: AgentContinuationFrame = Object.freeze({
      ...params.agentFrame,
      pausedAtPhase: 'TOOL_BOUNDARY',
      pauseState: Object.freeze({
        kind: 'prerequisite-wait',
        pendingToolBatch: params.pendingToolBatch,
      }),
    });
    const stack: readonly ContinuationFrame[] = Object.freeze([
      ...(params.outerFrames ?? []),
      suspendedFrame,
    ]);
    if (params.continuationQueue !== undefined) {
      await params.continuationQueue.enqueueUpdate(params.ctx.stepExecId, () =>
        params.ledgerStore.updateContinuationStack(params.ctx.runId, params.ctx.stepExecId, stack),
      );
    } else {
      await params.ledgerStore.updateContinuationStack(
        params.ctx.runId,
        params.ctx.stepExecId,
        stack,
      );
    }
    const loopFrame = params.outerFrames?.find(
      (f: ContinuationFrame): f is LoopContinuationFrame => f.kind === 'loop-frame',
    );
    const custom =
      (await getStepRuntimeInternals(params.ctx)?.collectCustomTelemetry?.()) ?? Object.freeze({});
    const stepTelemetry = Object.freeze<UniversalStepTelemetry>({
      turnsTaken: loopFrame?.turnsTaken ?? params.agentFrame.turnsTaken,
      costUsd: loopFrame?.costUsd ?? params.agentFrame.costUsd,
      durationMs: loopFrame?.elapsedDurationMs ?? params.agentFrame.elapsedDurationMs,
      custom,
      abortMeta: undefined,
    });
    await params.ledgerStore.recordStepTransition({
      stepExecId: params.ctx.stepExecId,
      status: 'SUSPENDED',
      headScopeCheckpoint: headCkpt,
      telemetryJson: JSON.stringify(stepTelemetry),
    });
  }
  return headCkpt;
}

/**
 * Computes the effective priority level for a dynamically spawned task (`SPEC.md` §3.7.2).
 *
 * Applies `priorityStrategy` (`'normal'` or `'inherit-parent-with-boost'`).
 *
 * @param {'inherit-parent-with-boost' | 'normal'}             strategy       - Configured priority strategy on `.canSpawnTasks()`.
 * @param {'low' | 'normal' | 'high' | 'critical' | undefined} parentPriority - Parent work item base priority level.
 *
 * @returns {'low' | 'normal' | 'high' | 'critical'} Resolved task priority level.
 */
function computeSpawnedTaskPriority(
  strategy: 'inherit-parent-with-boost' | 'normal',
  parentPriority: 'low' | 'normal' | 'high' | 'critical' | undefined,
): 'low' | 'normal' | 'high' | 'critical' {
  if (strategy === 'normal') {
    return 'normal';
  }
  if (parentPriority === 'low') {
    return 'normal';
  }
  if (parentPriority === 'high' || parentPriority === 'critical') {
    return 'critical';
  }
  return 'high';
}

/**
 * Parameters passed to `applyPrerequisiteSyncToAgentFrame`.
 */
interface ApplyPrerequisiteSyncToAgentFrameParams {
  /** Paused `AgentContinuationFrame` to update with prerequisite sync state. */
  readonly agentFrame: AgentContinuationFrame;

  /** Checkpoint serialized after `syncRoot` settled. */
  readonly syncedToPrerequisiteCheckpoint: string | undefined;

  /** Whether a 3-way merge conflict armed `.beforeStop()` conflict checks. */
  readonly conflictCheckArmed: boolean;

  /** Temporary conflict-resolution lease granted on `syncRoot` conflict. */
  readonly conflictLease: LeaseDelta | undefined;

  /** Formatted `[PREREQUISITE_COMPLETED]`, `[PREREQUISITE_FAILED]`, and `[PREREQUISITE_SYNC]` notes. */
  readonly syncNotes: readonly string[];

  /** Whether all prerequisite items reached a successful terminal exit. */
  readonly allSucceeded: boolean;
}

/**
 * Updates a resumed `AgentContinuationFrame` with `syncedToPrerequisiteCheckpoint`, `conflictLease`, and prerequisite sync notes (`SPEC.md` §3.7.2).
 *
 * Pairs `spawnTasks` / `addDependencies` tool calls in `remainingCalls[0]` or appends `syncNotes` to the latest completed tool result.
 *
 * @param {ApplyPrerequisiteSyncToAgentFrameParams} params - Agent frame and prerequisite sync outcome.
 *
 * @returns {AgentContinuationFrame} Updated `AgentContinuationFrame`.
 */
function applyPrerequisiteSyncToAgentFrame(
  params: ApplyPrerequisiteSyncToAgentFrameParams,
): AgentContinuationFrame {
  const {
    agentFrame,
    syncedToPrerequisiteCheckpoint,
    conflictCheckArmed,
    conflictLease,
    syncNotes,
    allSucceeded,
  } = params;
  const nextLeases =
    conflictLease !== undefined
      ? Object.freeze([...agentFrame.activeLeases, conflictLease])
      : agentFrame.activeLeases;
  const prevBatch =
    agentFrame.pauseState.kind === 'prerequisite-wait' ||
    agentFrame.pauseState.kind === 'tool-batch'
      ? agentFrame.pauseState.pendingToolBatch
      : undefined;
  if (prevBatch === undefined) {
    return Object.freeze<AgentContinuationFrame>({
      ...agentFrame,
      activeLeases: nextLeases,
      conflictCheckArmed,
      syncedToPrerequisiteCheckpoint,
      pauseState: agentFrame.pauseState,
    });
  }
  const headCall = prevBatch.remainingCalls[0];
  const isPlanMutationCall =
    headCall?.toolName === 'spawnTasks' || headCall?.toolName === 'addDependencies';
  let settledCompleted = [...prevBatch.completedResults];
  if (isPlanMutationCall && headCall !== undefined) {
    settledCompleted.push(
      Object.freeze({
        callId: headCall.callId,
        content: syncNotes.join('\n') || '{"status":"RESUMED"}',
        isError: !allSucceeded,
      }),
    );
  } else if (syncNotes.length > 0 && settledCompleted.length > 0) {
    const lastIdx = settledCompleted.length - 1;
    const lastResult = settledCompleted[lastIdx];
    if (lastResult !== undefined) {
      settledCompleted[lastIdx] = Object.freeze({
        ...lastResult,
        content: `${lastResult.content}\n${syncNotes.join('\n')}`,
      });
    }
  }
  const nextRemaining = isPlanMutationCall
    ? Object.freeze(prevBatch.remainingCalls.slice(1))
    : prevBatch.remainingCalls;
  const nextPauseState = Object.freeze({
    kind: 'tool-batch' as const,
    pendingToolBatch: Object.freeze({
      ...prevBatch,
      completedResults: Object.freeze(settledCompleted),
      remainingCalls: nextRemaining,
    }),
  });
  return Object.freeze<AgentContinuationFrame>({
    ...agentFrame,
    activeLeases: nextLeases,
    conflictCheckArmed,
    syncedToPrerequisiteCheckpoint,
    pauseState: nextPauseState,
  });
}

/**
 * Executes the `spawnTasks` capability tool with linear prerequisite chaining ($T_{\text{prevTip}} \leftarrow T_1 \leftarrow \dots \leftarrow T_k \leftarrow T_{\text{parent}}$) (`SPEC.md` §3.7.2).
 *
 * Enforces `maxSpawnedPerRun`, applies `enforcePatch`, computes `'inherit-parent-with-boost'` priority,
 * commits `LedgerStore.mutateLanePlan()`, and suspends the parent run with `headScopeCheckpoint`.
 *
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {PlanMutationParams<THandle>} params - Plan mutation parameters and task list.
 *
 * @returns {Promise<PlanMutationResult>} Chained prerequisite keys and suspension metadata.
 */
export async function executeSpawnTasks<THandle = unknown>(
  params: PlanMutationParams<THandle>,
): Promise<PlanMutationResult> {
  const cfg = params.mutatePlanNode.spawnTasks;
  if (cfg === undefined) {
    throw new Error(`spawnTasks is not enabled on mutatePlan in run '${params.ctx.runId}'.`);
  }
  const rawTasks = params.tasksToSpawn ?? [];
  if (rawTasks.length === 0) {
    throw new Error(`spawnTasks requires at least 1 task in run '${params.ctx.runId}'.`);
  }
  const prevCount = params.previouslySpawnedCount ?? 0;
  if (prevCount + rawTasks.length > cfg.maxSpawnedPerRun) {
    throw new Error(
      `spawnTasks count (${String(prevCount + rawTasks.length)}) exceeds maxSpawnedPerRun (${String(cfg.maxSpawnedPerRun)}) in run '${params.ctx.runId}'.`,
    );
  }
  const boostedPriority = computeSpawnedTaskPriority(cfg.priorityStrategy, params.parentPriority);
  const spawnedItems: MutateLanePlanSpawnedItem[] = [];
  const itemKeys: string[] = [];
  let rollingTip = params.previousSpawnedTipKey;
  for (let i = 0; i < rawTasks.length; i += 1) {
    const entry = rawTasks[i];
    if (entry === undefined) {
      continue;
    }
    const parsed = cfg.itemSchema.parse(entry.item);
    const patched =
      cfg.enforcePatch !== undefined && typeof parsed === 'object' && parsed !== null
        ? {
            ...(parsed as Record<string, unknown>),
            ...(cfg.enforcePatch as Record<string, unknown>),
          }
        : parsed;
    const itemKey =
      entry.itemKey ??
      (typeof patched === 'object' &&
      patched !== null &&
      typeof (patched as Record<string, unknown>)['id'] === 'string'
        ? String((patched as Record<string, unknown>)['id'])
        : `${params.parentItemKey}:sub:${String(prevCount + i + 1)}`);
    const deps = new Set<string>(entry.dependsOn ?? []);
    if (rollingTip !== undefined) {
      deps.add(rollingTip);
    }
    spawnedItems.push(
      Object.freeze({
        itemKey,
        inputJson: JSON.stringify(patched),
        dependsOn: Object.freeze(Array.from(deps)),
        priority: boostedPriority,
      }),
    );
    itemKeys.push(itemKey);
    rollingTip = itemKey;
  }
  await params.ledgerStore.mutateLanePlan({
    laneId: params.laneId,
    parentRunId: params.ctx.runId,
    parentItemKey: params.parentItemKey,
    maxPrerequisiteDepth: cfg.maxPrerequisiteDepth,
    spawnedItems: Object.freeze(spawnedItems),
    addedDependencies: rollingTip !== undefined ? Object.freeze([rollingTip]) : undefined,
  });
  const headCkpt = await suspendParentStepForPrerequisites(params);
  return Object.freeze<PlanMutationResult>({
    prerequisiteItemKeys: Object.freeze(itemKeys),
    latestTipItemKey: rollingTip,
    suspended: true,
    headScopeCheckpoint: headCkpt,
    toolResultText: JSON.stringify({
      spawnedItemKeys: itemKeys,
      tipKey: rollingTip,
      status: 'SUSPENDED',
    }),
  });
}

/**
 * Executes the `addDependencies` capability tool to register existing lane items as prerequisites (`SPEC.md` §3.7.2).
 *
 * Validates acyclicity and `maxPrerequisiteDepth` in `LedgerStore.mutateLanePlan()` and suspends
 * the parent step if any added prerequisite has not yet reached a terminal state.
 *
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {PlanMutationParams<THandle>} params - Plan mutation parameters and dependency item keys.
 *
 * @returns {Promise<PlanMutationResult>} Added dependency keys and suspension status.
 */
export async function executeAddDependencies<THandle = unknown>(
  params: PlanMutationParams<THandle>,
): Promise<PlanMutationResult> {
  if (!params.mutatePlanNode.canAddDependencies) {
    throw new Error(`addDependencies is not enabled on mutatePlan in run '${params.ctx.runId}'.`);
  }
  const depKeys = params.dependencyKeysToAdd ?? [];
  const graph = new Graph({ directed: true });
  for (const depKey of depKeys) {
    if (depKey === params.parentItemKey) {
      throw new Error(`Self-dependency cycle on '${depKey}' in run '${params.ctx.runId}'.`);
    }
    graph.setEdge(params.parentItemKey, depKey);
  }
  if (alg.findCycles(graph).length > 0) {
    throw new Error(`Prerequisite dependency cycle detected in run '${params.ctx.runId}'.`);
  }
  const maxDepth = params.mutatePlanNode.spawnTasks?.maxPrerequisiteDepth ?? 3;
  await params.ledgerStore.mutateLanePlan({
    laneId: params.laneId,
    parentRunId: params.ctx.runId,
    parentItemKey: params.parentItemKey,
    maxPrerequisiteDepth: maxDepth,
    addedDependencies: depKeys,
  });
  const receipts = await params.ledgerStore.getRunTerminalReceipts(depKeys);
  const allDone = depKeys.every((k) => receipts.has(k));
  const headCkpt = !allDone ? await suspendParentStepForPrerequisites(params) : undefined;
  return Object.freeze<PlanMutationResult>({
    prerequisiteItemKeys: Object.freeze([...depKeys]),
    latestTipItemKey: depKeys[depKeys.length - 1],
    suspended: !allDone,
    headScopeCheckpoint: headCkpt,
    toolResultText: JSON.stringify({
      addedDependencies: depKeys,
      status: allDone ? 'READY' : 'SUSPENDED',
    }),
  });
}

/**
 * Executes the `updatePartitionContract` capability tool against the run's isolated CoW `TopologyStore` overlay (`SPEC.md` §3.3).
 *
 * Tags the overlay update with `ctx.stepExecId` so step-scoped `.retry()` or `.replaceWith()` rollbacks
 * preserve prior completed steps' contract mutations.
 *
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {PlanMutationParams<THandle>} params - Plan mutation parameters with `contractUpdate` and `topologyStore`.
 *
 * @returns {Promise<{ readonly partitionId: string; readonly newEpoch: number }>} Updated partition ID and overlay epoch.
 */
export async function executeUpdatePartitionContract<THandle = unknown>(
  params: PlanMutationParams<THandle>,
): Promise<{ readonly partitionId: string; readonly newEpoch: number }> {
  if (
    params.mutatePlanNode.topologyToUpdate === undefined ||
    params.topologyStore === undefined ||
    params.contractUpdate === undefined
  ) {
    throw new Error(
      `updatePartitionContract requires topologyToUpdate and TopologyStore in run '${params.ctx.runId}'.`,
    );
  }
  const { partitionId, newContractText } = params.contractUpdate;
  const res = await params.topologyStore.updateContract(
    params.ctx.runId,
    partitionId,
    newContractText,
    params.ctx.stepExecId,
  );
  return Object.freeze({ partitionId, newEpoch: res.newEpoch });
}

/**
 * Synchronizes completed prerequisite receipts, topology overlays, and `syncRoot` upon `'SUSPENDED'` wakeup or initial run start (`SPEC.md` §3.7.2).
 *
 * Enforces replay idempotency by restoring `headScopeCheckpoint` before `syncRoot` and persisting
 * `syncedToPrerequisiteCheckpoint` before re-acquiring services and draining `remainingCalls`.
 *
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {SyncPrerequisitesParams<THandle>} params - Prerequisite wakeup synchronization parameters.
 *
 * @returns {Promise<SyncPrerequisitesResult>} Synchronization notes, conflict lease, and updated agent frame.
 */
export async function syncSuspendedRunPrerequisites<THandle = unknown>(
  params: SyncPrerequisitesParams<THandle>,
): Promise<SyncPrerequisitesResult> {
  const receiptsMap = await params.ledgerStore.getRunTerminalReceipts(params.prerequisiteItemKeys);
  const syncNotes: string[] = [];
  const prereqReceipts: Record<string, unknown>[] = [];
  const prereqRunIdSet = new Set<string>(params.prerequisiteRunIds ?? []);
  let allSucceeded = true;
  for (const key of params.prerequisiteItemKeys) {
    const rec = receiptsMap.get(key);
    if (rec === undefined) {
      continue;
    }
    prereqRunIdSet.add(rec.runId);
    if (
      rec.terminalState === 'failed' ||
      rec.terminalState === 'errored' ||
      rec.terminalState === 'cancelled'
    ) {
      allSucceeded = false;
      syncNotes.push(
        `[PREREQUISITE_FAILED] Prerequisite '${key}' (run '${rec.runId}') exited in state '${rec.terminalState}'.`,
      );
    } else if (rec.scopeReceiptJson !== undefined) {
      prereqReceipts.push(JSON.parse(rec.scopeReceiptJson) as Record<string, unknown>);
    }
  }
  if (prereqRunIdSet.size > 0 && params.topologyStore !== undefined) {
    const prereqRunIds = Array.from(prereqRunIdSet);
    await params.topologyStore.syncRunOverlays(params.runId, prereqRunIds);
    syncNotes.push(
      `[TOPOLOGY_SYNC] Merged topology overlays from prerequisite runs: ${prereqRunIds.join(', ')}.`,
    );
  }
  let conflictLease;
  let conflictCheckArmed = params.agentFrame?.conflictCheckArmed === true;
  let updatedFrame = params.agentFrame;
  let postCkpt = params.agentFrame?.syncedToPrerequisiteCheckpoint;
  if (
    params.branchableScope !== undefined &&
    params.agentFrame?.syncedToPrerequisiteCheckpoint === undefined &&
    prereqReceipts.length > 0
  ) {
    if (params.headScopeCheckpoint !== undefined) {
      await params.branchableScope.restoreCheckpoint(params.scopeHandle, params.headScopeCheckpoint);
    }
    const syncRes = await params.branchableScope.syncRoot(params.scopeHandle, prereqReceipts);
    if (syncRes.status === 'conflict') {
      conflictLease = params.branchableScope.getConflictLease?.(params.scopeHandle);
      conflictCheckArmed = true;
      syncNotes.push(
        `[PREREQUISITE_SYNC] Conflict detected while syncing prerequisite receipts (${syncRes.conflictedSummary}); conflict lease attached.`,
      );
    } else {
      syncNotes.push(
        `[PREREQUISITE_SYNC] Cleanly synchronized ${String(prereqReceipts.length)} prerequisite receipt(s).`,
      );
    }
    postCkpt = await params.branchableScope.serializeCheckpoint(params.scopeHandle);
  }
  if (updatedFrame !== undefined) {
    updatedFrame = applyPrerequisiteSyncToAgentFrame({
      agentFrame: updatedFrame,
      syncedToPrerequisiteCheckpoint: postCkpt,
      conflictCheckArmed,
      conflictLease,
      syncNotes,
      allSucceeded,
    });
    const stack: readonly ContinuationFrame[] = Object.freeze([
      ...(params.outerFrames ?? []),
      updatedFrame,
    ]);
    if (params.continuationQueue !== undefined) {
      await params.continuationQueue.enqueueUpdate(params.stepExecId, () =>
        params.ledgerStore.updateContinuationStack(params.runId, params.stepExecId, stack),
      );
    } else {
      await params.ledgerStore.updateContinuationStack(params.runId, params.stepExecId, stack);
    }
  }
  return Object.freeze<SyncPrerequisitesResult>({
    allPrerequisitesSucceeded: allSucceeded,
    syncNotes: Object.freeze(syncNotes),
    conflictLease,
    conflictCheckArmed,
    updatedAgentFrame: updatedFrame,
  });
}
