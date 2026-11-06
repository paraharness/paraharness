import type {
  ForkBatchContinuationFrame,
  ForkBatchEntryRecord,
  PendingPauseTriggerRecord,
} from '../../ports/fork-batch-continuation-frame.js';
import type {
  ForkBatchExecutionParams,
  ForkBatchExecutionResult,
} from './fork-batch-execution-params.js';
import {
  coordinateTurnBatchInterruptBarrier,
  reconcileChildForkWithBounce,
} from './internal/fork-barrier-and-pause.js';
import { resumeSuspendedForkEntry } from './internal/resume-fork-cases.js';

/**
 * Executes a concurrent batch of downward `.fork()` tool calls with turn-batch sibling barrier and 3-way `commitChild` (`SPEC.md` §3.7.2).
 *
 * Forks isolated child scopes under a shared read lock on `parentHandle`, runs child executables concurrently,
 * coordinates upward interrupt barriers across siblings, and commits completed children sequentially.
 *
 * @template THandle Runtime handle type of the active `BranchableScope`.
 *
 * @param {ForkBatchExecutionParams<THandle>} params - Fork batch execution parameters.
 *
 * @returns {Promise<ForkBatchExecutionResult>} Per-`callId` tool results and settled `ForkBatchContinuationFrame`.
 */
export async function executeForkBatch<THandle = unknown>(
  params: ForkBatchExecutionParams<THandle>,
): Promise<ForkBatchExecutionResult> {
  const calls = params.forkCalls ?? [], entriesByForkId = new Map<string, ForkBatchEntryRecord>(), handlesByForkId = new Map<string, THandle>();
  const triggers: PendingPauseTriggerRecord[] = [...(params.existingBatchFrame?.pendingPauseTriggers ?? [])];
  for (const existing of params.existingBatchFrame?.forks ?? []) entriesByForkId.set(existing.forkId, existing);
  const persistEntryUpdate = async (updated: ForkBatchEntryRecord): Promise<void> => {
    entriesByForkId.set(updated.forkId, updated);
    const frame: ForkBatchContinuationFrame = Object.freeze({ kind: 'fork-batch-frame', parentStepExecId: params.ctx.stepExecId, pendingPauseTriggers: triggers.length > 0 ? Object.freeze([...triggers]) : undefined, forks: Object.freeze(Array.from(entriesByForkId.values())) });
    await params.continuationQueue.enqueueUpdate(params.ctx.stepExecId, () => params.ledgerStore.updateContinuationStack(params.ctx.runId, params.ctx.stepExecId, Object.freeze([...params.outerFrames, frame])));
  };
  for (const call of calls) {
    if (entriesByForkId.has(call.forkId)) continue;
    const childInput = call.capability.mapInput(params.parentInput, call.capability.requestSchema.parse(JSON.parse(call.argsJson || '{}')));
    const parts = call.capability.childExecutable.extractPartitions !== undefined ? call.capability.childExecutable.extractPartitions(childInput) : params.ctx.activePartitions;
    entriesByForkId.set(call.forkId, Object.freeze<ForkBatchEntryRecord>({ forkId: call.forkId, callId: call.callId, toolName: call.capability.toolName, activePartitions: Object.freeze([...parts]), status: 'RUNNING', conflictRetryCount: 0, conflictCheckArmed: false, suspensionEpoch: 0, continuationStack: Object.freeze([]) }));
  }
  const resultsMap = new Map<string, { readonly content: string; readonly isError: boolean }>();
  for (const call of calls) {
    const entry = entriesByForkId.get(call.forkId);
    if (entry === undefined) continue;
    const childInput = call.capability.mapInput(params.parentInput, call.capability.requestSchema.parse(JSON.parse(call.argsJson || '{}')));
    const childHandle = await params.lockManager.withReadLock(params.ctx.scopeHandle, () => params.branchableScope.forkChild(params.ctx.scopeHandle, call.forkId));
    handlesByForkId.set(call.forkId, childHandle);
    const initLease = params.branchableScope.getConflictLease?.(childHandle);
    const outcome = await params.executeChildStep(call.capability.childExecutable, childInput, Object.freeze({ ...params.ctx, scopeHandle: childHandle, activePartitions: entry.activePartitions, activeLeases: initLease !== undefined ? Object.freeze([...params.ctx.activeLeases, initLease]) : params.ctx.activeLeases, resumeContinuationStack: entry.continuationStack.length > 0 ? entry.continuationStack : undefined }));
    if (outcome.status === 'interrupt-raised') {
      const barrier = await coordinateTurnBatchInterruptBarrier(params, entry, { ...outcome, childHandle, siblingEntries: Array.from(entriesByForkId.values()), handlesByForkId });
      triggers.push(barrier.trigger);
      await persistEntryUpdate(barrier.updatedRaisingEntry);
      for (const paused of barrier.pausedSiblings) await persistEntryUpdate(paused);
    } else await reconcileChildForkWithBounce({ batchParams: params, entry, childHandle, childNode: call.capability.childExecutable, childInput, outcome, persistEntryUpdate });
  }
  for (const settled of entriesByForkId.values()) resultsMap.set(settled.callId, { content: settled.toolResultJson ?? '{}', isError: settled.status === 'FAILED' });
  const finalFrame: ForkBatchContinuationFrame = Object.freeze({ kind: 'fork-batch-frame', parentStepExecId: params.ctx.stepExecId, pendingPauseTriggers: triggers.length > 0 ? Object.freeze([...triggers]) : undefined, forks: Object.freeze(Array.from(entriesByForkId.values())) });
  return Object.freeze<ForkBatchExecutionResult>({ toolResultsByCallId: resultsMap, batchFrame: finalFrame, pauseTriggers: Object.freeze(triggers) });
}

/**
 * Executes the built-in `resumeFork` capability tool to resume or abort suspended child forks (`SPEC.md` §3.7.2).
 *
 * Supports multi-ID `suspendedForkIds` aggregation into a single `tool_result`, `action: 'abort'`,
 * replay-idempotent `restoreCheckpoint` + `syncChild`, Cases A/B/C, and atomic `resolveSuspendedFork`.
 *
 * @template THandle Runtime handle type of the active `BranchableScope`.
 *
 * @param {ForkBatchExecutionParams<THandle>} params - Resume fork batch execution parameters.
 *
 * @returns {Promise<ForkBatchExecutionResult>} Aggregated `resumeFork` tool result and settled batch frame.
 */
export async function executeResumeForkBatch<THandle = unknown>(
  params: ForkBatchExecutionParams<THandle>,
): Promise<ForkBatchExecutionResult> {
  const req = params.resumeRequest;
  if (req === undefined) throw new Error(`executeResumeForkBatch requires resumeRequest in run '${params.ctx.runId}'.`);
  const suspendedRecords = await params.ledgerStore.getSuspendedForks(params.ctx.runId, { forkIds: req.suspendedForkIds, parentStepExecId: params.ctx.stepExecId });
  const entriesByForkId = new Map<string, ForkBatchEntryRecord>();
  const persistEntryUpdate = async (updated: ForkBatchEntryRecord): Promise<void> => {
    entriesByForkId.set(updated.forkId, updated);
    const frame: ForkBatchContinuationFrame = Object.freeze({ kind: 'fork-batch-frame', parentStepExecId: params.ctx.stepExecId, forks: Object.freeze(Array.from(entriesByForkId.values())) });
    await params.continuationQueue.enqueueUpdate(params.ctx.stepExecId, () => params.ledgerStore.updateContinuationStack(params.ctx.runId, params.ctx.stepExecId, Object.freeze([...params.outerFrames, frame])));
  };
  const perForkOutputs: unknown[] = [];
  for (const record of suspendedRecords) {
    if (req.action === 'abort') {
      await params.ledgerStore.resolveSuspendedFork(record.suspendedForkId, 'ABORTED');
      const aborted = Object.freeze<ForkBatchEntryRecord>({ forkId: record.forkId, suspendedForkId: record.suspendedForkId, callId: req.callId, toolName: 'resumeFork', activePartitions: record.activePartitions, status: 'ABORTED', conflictRetryCount: record.conflictRetryCount, conflictCheckArmed: record.conflictCheckArmed, suspensionEpoch: record.suspensionEpoch, continuationStack: record.continuationStack, toolResultJson: JSON.stringify({ suspendedForkId: record.suspendedForkId, forkId: record.forkId, status: 'ABORTED' }) });
      await persistEntryUpdate(aborted);
      perForkOutputs.push({ suspendedForkId: record.suspendedForkId, forkId: record.forkId, status: 'ABORTED' });
      continue;
    }
    const initialEntry: ForkBatchEntryRecord = params.existingBatchFrame?.forks.find((f) => f.suspendedForkId === record.suspendedForkId) ?? Object.freeze<ForkBatchEntryRecord>({ forkId: record.forkId, suspendedForkId: record.suspendedForkId, callId: req.callId, toolName: record.forkToolName, activePartitions: record.activePartitions, status: 'RUNNING', conflictRetryCount: record.conflictRetryCount, conflictCheckArmed: record.conflictCheckArmed, suspensionEpoch: record.suspensionEpoch, syncedToParentCheckpoint: record.syncedToParentCheckpoint, syncResultJson: record.syncResultJson, resumeFrameInjected: record.resumeFrameInjected, childScopeCheckpoint: record.childScopeCheckpoint, continuationStack: record.continuationStack });
    const settled = await resumeSuspendedForkEntry({ batchParams: params, record, entry: initialEntry, resolutionSummary: req.resolutionSummary, persistEntryUpdate });
    perForkOutputs.push(JSON.parse(settled.toolResultJson ?? '{}'));
  }
  const resultsMap = new Map<string, { readonly content: string; readonly isError: boolean }>([[req.callId, { content: JSON.stringify({ action: req.action, results: perForkOutputs }), isError: false }]]);
  const finalFrame: ForkBatchContinuationFrame = Object.freeze({ kind: 'fork-batch-frame', parentStepExecId: params.ctx.stepExecId, forks: Object.freeze(Array.from(entriesByForkId.values())) });
  return Object.freeze<ForkBatchExecutionResult>({ toolResultsByCallId: resultsMap, batchFrame: finalFrame, pauseTriggers: Object.freeze([]) });
}
