import { Graph, alg } from '@dagrejs/graphlib';
import type { AgentContinuationFrame } from '../../ports/agent-continuation-frame.js';
import type { ContinuationFrame } from '../../ports/continuation-frame.types.js';
import type { MutateLanePlanSpawnedItem } from '../../ports/mutate-lane-plan-request.js';
import type { PlanMutationParams } from './plan-mutation-params.js';
import type { PlanMutationResult } from './plan-mutation-result.js';
import type { SyncPrerequisitesParams } from './sync-prerequisites-params.js';
import type { SyncPrerequisitesResult } from './sync-prerequisites-result.js';

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
  if (cfg === undefined) throw new Error(`spawnTasks is not enabled on mutatePlan in run '${params.ctx.runId}'.`);
  const rawTasks = params.tasksToSpawn ?? [];
  if (rawTasks.length === 0) throw new Error(`spawnTasks requires at least 1 task in run '${params.ctx.runId}'.`);
  const prevCount = params.previouslySpawnedCount ?? 0;
  if (prevCount + rawTasks.length > cfg.maxSpawnedPerRun) {
    throw new Error(`spawnTasks count (${String(prevCount + rawTasks.length)}) exceeds maxSpawnedPerRun (${String(cfg.maxSpawnedPerRun)}) in run '${params.ctx.runId}'.`);
  }
  const boostedPriority: 'low' | 'normal' | 'high' | 'critical' = cfg.priorityStrategy === 'normal' ? 'normal'
    : params.parentPriority === 'low' ? 'normal' : params.parentPriority === 'high' || params.parentPriority === 'critical' ? 'critical' : 'high';
  const spawnedItems: MutateLanePlanSpawnedItem[] = [];
  const itemKeys: string[] = [];
  let rollingTip = params.previousSpawnedTipKey;
  for (let i = 0; i < rawTasks.length; i += 1) {
    const entry = rawTasks[i];
    if (entry === undefined) continue;
    const parsed = cfg.itemSchema.parse(entry.item);
    const patched = cfg.enforcePatch !== undefined && typeof parsed === 'object' && parsed !== null ? { ...(parsed as Record<string, unknown>), ...(cfg.enforcePatch as Record<string, unknown>) } : parsed;
    const itemKey = entry.itemKey ?? (typeof patched === 'object' && patched !== null && typeof (patched as Record<string, unknown>)['id'] === 'string' ? String((patched as Record<string, unknown>)['id']) : `${params.parentItemKey}:sub:${String(prevCount + i + 1)}`);
    const deps = new Set<string>(entry.dependsOn ?? []);
    if (rollingTip !== undefined) deps.add(rollingTip);
    spawnedItems.push(Object.freeze({ itemKey, inputJson: JSON.stringify(patched), dependsOn: Object.freeze(Array.from(deps)), priority: boostedPriority }));
    itemKeys.push(itemKey);
    rollingTip = itemKey;
  }
  await params.ledgerStore.mutateLanePlan({ laneId: params.laneId, parentRunId: params.ctx.runId, parentItemKey: params.parentItemKey, maxPrerequisiteDepth: cfg.maxPrerequisiteDepth, spawnedItems: Object.freeze(spawnedItems), addedDependencies: rollingTip !== undefined ? Object.freeze([rollingTip]) : undefined });
  await params.serviceRegistry?.quiesceScopeServices();
  const headCkpt = params.checkpointScope !== undefined ? await params.checkpointScope.serializeCheckpoint(params.ctx.scopeHandle) : undefined;
  if (params.agentFrame !== undefined && params.pendingToolBatch !== undefined) {
    const suspendedFrame: AgentContinuationFrame = Object.freeze({ ...params.agentFrame, pausedAtPhase: 'TOOL_BOUNDARY', pauseState: Object.freeze({ kind: 'prerequisite-wait', pendingToolBatch: params.pendingToolBatch }) });
    const stack: readonly ContinuationFrame[] = Object.freeze([...(params.outerFrames ?? []), suspendedFrame]);
    await (params.continuationQueue !== undefined ? params.continuationQueue.enqueueUpdate(params.ctx.stepExecId, () => params.ledgerStore.updateContinuationStack(params.ctx.runId, params.ctx.stepExecId, stack)) : params.ledgerStore.updateContinuationStack(params.ctx.runId, params.ctx.stepExecId, stack));
    await params.ledgerStore.recordStepTransition({ stepExecId: params.ctx.stepExecId, status: 'SUSPENDED', headScopeCheckpoint: headCkpt, telemetryJson: JSON.stringify({ turnsTaken: params.agentFrame.turnsTaken, costUsd: params.agentFrame.costUsd }) });
  }
  return Object.freeze<PlanMutationResult>({ prerequisiteItemKeys: Object.freeze(itemKeys), latestTipItemKey: rollingTip, suspended: true, headScopeCheckpoint: headCkpt, toolResultText: JSON.stringify({ spawnedItemKeys: itemKeys, tipKey: rollingTip, status: 'SUSPENDED' }) });
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
    if (depKey === params.parentItemKey) throw new Error(`Self-dependency cycle on '${depKey}' in run '${params.ctx.runId}'.`);
    graph.setEdge(params.parentItemKey, depKey);
  }
  if (alg.findCycles(graph).length > 0) throw new Error(`Prerequisite dependency cycle detected in run '${params.ctx.runId}'.`);
  const maxDepth = params.mutatePlanNode.spawnTasks?.maxPrerequisiteDepth ?? 3;
  await params.ledgerStore.mutateLanePlan({ laneId: params.laneId, parentRunId: params.ctx.runId, parentItemKey: params.parentItemKey, maxPrerequisiteDepth: maxDepth, addedDependencies: depKeys });
  const receipts = await params.ledgerStore.getRunTerminalReceipts(depKeys);
  const allDone = depKeys.every((k) => receipts.has(k));
  let headCkpt: string | undefined;
  if (!allDone) {
    await params.serviceRegistry?.quiesceScopeServices();
    headCkpt = params.checkpointScope !== undefined ? await params.checkpointScope.serializeCheckpoint(params.ctx.scopeHandle) : undefined;
    if (params.agentFrame !== undefined && params.pendingToolBatch !== undefined) {
      const suspendedFrame: AgentContinuationFrame = Object.freeze({ ...params.agentFrame, pausedAtPhase: 'TOOL_BOUNDARY', pauseState: Object.freeze({ kind: 'prerequisite-wait', pendingToolBatch: params.pendingToolBatch }) });
      const stack: readonly ContinuationFrame[] = Object.freeze([...(params.outerFrames ?? []), suspendedFrame]);
      await (params.continuationQueue !== undefined ? params.continuationQueue.enqueueUpdate(params.ctx.stepExecId, () => params.ledgerStore.updateContinuationStack(params.ctx.runId, params.ctx.stepExecId, stack)) : params.ledgerStore.updateContinuationStack(params.ctx.runId, params.ctx.stepExecId, stack));
      await params.ledgerStore.recordStepTransition({ stepExecId: params.ctx.stepExecId, status: 'SUSPENDED', headScopeCheckpoint: headCkpt, telemetryJson: JSON.stringify({ turnsTaken: params.agentFrame.turnsTaken, costUsd: params.agentFrame.costUsd }) });
    }
  }
  return Object.freeze<PlanMutationResult>({ prerequisiteItemKeys: Object.freeze([...depKeys]), latestTipItemKey: depKeys[depKeys.length - 1], suspended: !allDone, headScopeCheckpoint: headCkpt, toolResultText: JSON.stringify({ addedDependencies: depKeys, status: allDone ? 'READY' : 'SUSPENDED' }) });
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
  if (params.mutatePlanNode.topologyToUpdate === undefined || params.topologyStore === undefined || params.contractUpdate === undefined) {
    throw new Error(`updatePartitionContract requires topologyToUpdate and TopologyStore in run '${params.ctx.runId}'.`);
  }
  const { partitionId, newContractText } = params.contractUpdate;
  const res = await params.topologyStore.updateContract(params.ctx.runId, partitionId, newContractText, params.ctx.stepExecId);
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
export async function syncSuspendedRunPrerequisites<THandle = unknown>(params: SyncPrerequisitesParams<THandle>): Promise<SyncPrerequisitesResult> {
  const receiptsMap = await params.ledgerStore.getRunTerminalReceipts(params.prerequisiteItemKeys);
  const syncNotes: string[] = [];
  const prereqReceipts: Record<string, unknown>[] = [];
  const prereqRunIdSet = new Set<string>(params.prerequisiteRunIds ?? []);
  let allSucceeded = true;
  for (const key of params.prerequisiteItemKeys) {
    const rec = receiptsMap.get(key);
    if (rec === undefined) continue;
    prereqRunIdSet.add(rec.runId);
    if (rec.terminalState === 'failed' || rec.terminalState === 'errored' || rec.terminalState === 'cancelled') {
      allSucceeded = false;
      syncNotes.push(`[PREREQUISITE_FAILED] Prerequisite '${key}' (run '${rec.runId}') exited in state '${rec.terminalState}'.`);
    } else if (rec.scopeReceiptJson !== undefined) prereqReceipts.push(JSON.parse(rec.scopeReceiptJson) as Record<string, unknown>);
  }
  if (prereqRunIdSet.size > 0 && params.topologyStore !== undefined) {
    const prereqRunIds = Array.from(prereqRunIdSet);
    await params.topologyStore.syncRunOverlays(params.runId, prereqRunIds);
    syncNotes.push(`[TOPOLOGY_SYNC] Merged topology overlays from prerequisite runs: ${prereqRunIds.join(', ')}.`);
  }
  let conflictLease;
  let conflictCheckArmed = params.agentFrame?.conflictCheckArmed === true;
  let updatedFrame = params.agentFrame;
  let postCkpt = params.agentFrame?.syncedToPrerequisiteCheckpoint;
  if (params.branchableScope !== undefined && params.agentFrame?.syncedToPrerequisiteCheckpoint === undefined && prereqReceipts.length > 0) {
    if (params.headScopeCheckpoint !== undefined) await params.branchableScope.restoreCheckpoint(params.scopeHandle, params.headScopeCheckpoint);
    const syncRes = await params.branchableScope.syncRoot(params.scopeHandle, prereqReceipts);
    if (syncRes.status === 'conflict') {
      conflictLease = params.branchableScope.getConflictLease?.(params.scopeHandle);
      conflictCheckArmed = true;
      syncNotes.push(`[PREREQUISITE_SYNC] Conflict detected while syncing prerequisite receipts (${syncRes.conflictedSummary}); conflict lease attached.`);
    } else syncNotes.push(`[PREREQUISITE_SYNC] Cleanly synchronized ${String(prereqReceipts.length)} prerequisite receipt(s).`);
    postCkpt = await params.branchableScope.serializeCheckpoint(params.scopeHandle);
  }
  if (updatedFrame !== undefined) {
    const nextLeases = conflictLease !== undefined ? Object.freeze([...updatedFrame.activeLeases, conflictLease]) : updatedFrame.activeLeases;
    const prevBatch = updatedFrame.pauseState.kind === 'prerequisite-wait' || updatedFrame.pauseState.kind === 'tool-batch' ? updatedFrame.pauseState.pendingToolBatch : undefined;
    const headCall = prevBatch?.remainingCalls[0];
    const settledCompleted = prevBatch !== undefined ? (headCall?.toolName === 'spawnTasks' || headCall?.toolName === 'addDependencies' ? [...prevBatch.completedResults, Object.freeze({ callId: headCall.callId, content: syncNotes.join('\n') || '{"status":"RESUMED"}', isError: !allSucceeded })] : prevBatch.completedResults.map((r, i) => i === prevBatch.completedResults.length - 1 && syncNotes.length > 0 ? Object.freeze({ ...r, content: `${r.content}\n${syncNotes.join('\n')}` }) : r)) : [];
    const nextPauseState = prevBatch !== undefined ? Object.freeze({ kind: 'tool-batch' as const, pendingToolBatch: Object.freeze({ ...prevBatch, completedResults: Object.freeze(settledCompleted), remainingCalls: headCall?.toolName === 'spawnTasks' || headCall?.toolName === 'addDependencies' ? Object.freeze(prevBatch.remainingCalls.slice(1)) : prevBatch.remainingCalls }) }) : updatedFrame.pauseState;
    const stack: readonly ContinuationFrame[] = Object.freeze([...(params.outerFrames ?? []), (updatedFrame = Object.freeze({ ...updatedFrame, activeLeases: nextLeases, conflictCheckArmed, syncedToPrerequisiteCheckpoint: postCkpt, pauseState: nextPauseState }))]);
    await (params.continuationQueue !== undefined ? params.continuationQueue.enqueueUpdate(params.stepExecId, () => params.ledgerStore.updateContinuationStack(params.runId, params.stepExecId, stack)) : params.ledgerStore.updateContinuationStack(params.runId, params.stepExecId, stack));
  }
  return Object.freeze<SyncPrerequisitesResult>({ allPrerequisitesSucceeded: allSucceeded, syncNotes: Object.freeze(syncNotes), conflictLease, conflictCheckArmed, updatedAgentFrame: updatedFrame });
}
