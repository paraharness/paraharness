import pLimit from 'p-limit';
import type {
  ForkBatchContinuationFrame,
  ForkBatchEntryRecord,
  PendingPauseTriggerRecord,
} from '../../ports/fork-batch-continuation-frame.js';
import type { ChildForkExecutionOutcome } from './child-fork-execution-outcome.js';
import type { ForkBatchExecutionParams } from './fork-batch-execution-params.js';
import type { ForkBatchExecutionResult } from './fork-batch-execution-result.js';
import {
  coordinateTurnBatchInterruptBarrier,
  reconcileChildForkWithBounce,
} from './internal/fork-barrier-and-pause.js';
import { resumeSuspendedForkEntry } from './internal/resume-fork-cases.js';
import {
  abortSuspendedForkRecord,
  executeDefaultForkOrTournamentChild,
  prepareForkCallContext,
} from './internal/run-single-fork-call.js';

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
export async function executeForkBatch<THandle = unknown>(params: ForkBatchExecutionParams<THandle>): Promise<ForkBatchExecutionResult> {
  const entriesByForkId = new Map<string, ForkBatchEntryRecord>((params.existingBatchFrame?.forks ?? []).map((f) => [f.forkId, f]));
  const handlesByForkId = new Map<string, THandle>();
  const triggers: PendingPauseTriggerRecord[] = [...(params.existingBatchFrame?.pendingPauseTriggers ?? [])];
  const unreleasedHandles = new Set<THandle>();
  const persistEntryUpdate = async (updated: ForkBatchEntryRecord): Promise<void> => {
    entriesByForkId.set(updated.forkId, updated);
    await params.continuationQueue.enqueueUpdate(params.ctx.stepExecId, () => params.ledgerStore.updateContinuationStack(params.ctx.runId, params.ctx.stepExecId, Object.freeze([...params.outerFrames, Object.freeze<ForkBatchContinuationFrame>({ kind: 'fork-batch-frame', parentStepExecId: params.ctx.stepExecId, pendingPauseTriggers: triggers.length > 0 ? Object.freeze([...triggers]) : undefined, forks: Object.freeze(Array.from(entriesByForkId.values())) })])));
  };
  const prepared: Array<Awaited<ReturnType<typeof prepareForkCallContext<THandle>>>> = [];
  const outcomesByForkId = new Map<string, ChildForkExecutionOutcome<unknown>>();
  let batchHasInterrupt = false;
  try {
    for (const call of params.forkCalls ?? []) {
      const prep = await prepareForkCallContext(params, call, entriesByForkId);
      handlesByForkId.set(call.forkId, (unreleasedHandles.add(prep.childHandle), prep.childHandle));
      prepared.push(prep);
    }
    const runStep = params.executeChildStep ?? ((cNode, cIn, cCtx) => executeDefaultForkOrTournamentChild(cNode, cIn, { childCtx: cCtx, ledgerStore: params.ledgerStore, lessonStore: params.lessonStore, lockManager: params.lockManager, continuationQueue: params.continuationQueue, poolManager: params.poolManager, humanAdaptersById: params.humanAdaptersById }));
    const limit = pLimit(Math.max(1, prepared.length));
    const settledOutcomes = await Promise.all(prepared.map((prep) => limit(() => runStep(prep.call.capability.childExecutable, prep.childInput, prep.childCtx))));
    for (let idx = 0; idx < prepared.length; idx += 1) {
      const prep = prepared[idx] as NonNullable<(typeof prepared)[number]>;
      const outcome = settledOutcomes[idx] as ChildForkExecutionOutcome<unknown>;
      outcomesByForkId.set(prep.call.forkId, outcome);
      entriesByForkId.set(prep.call.forkId, Object.freeze<ForkBatchEntryRecord>({ ...prep.entry, continuationStack: outcome.continuationStack }));
      if (outcome.status === 'interrupt-raised') batchHasInterrupt = true;
    }
    for (const prep of prepared) {
      const entry = entriesByForkId.get(prep.call.forkId);
      const outcome = outcomesByForkId.get(prep.call.forkId);
      if (entry !== undefined && outcome !== undefined && outcome.status !== 'interrupt-raised' && !(batchHasInterrupt && outcome.continuationStack.length > 0)) {
        unreleasedHandles.delete(prep.childHandle);
        await reconcileChildForkWithBounce({ batchParams: { ...params, executeChildStep: runStep }, entry, childHandle: prep.childHandle, childNode: prep.call.capability.childExecutable, childInput: prep.childInput, outcome, persistEntryUpdate });
      } else if (entry !== undefined && outcome?.status === 'interrupt-raised') {
        const barrier = await coordinateTurnBatchInterruptBarrier(params, entry, { ...outcome, childHandle: prep.childHandle, siblingEntries: Array.from(entriesByForkId.values()), handlesByForkId });
        triggers.push(barrier.trigger);
        for (const u of [barrier.updatedRaisingEntry, ...barrier.pausedSiblings]) await persistEntryUpdate(u);
      }
    }
    return Object.freeze<ForkBatchExecutionResult>({ toolResultsByCallId: new Map<string, { readonly content: string; readonly isError: boolean }>(Array.from(entriesByForkId.values()).map((s) => [s.callId, { content: s.toolResultJson ?? '{}', isError: s.status === 'FAILED' }])), batchFrame: Object.freeze({ kind: 'fork-batch-frame', parentStepExecId: params.ctx.stepExecId, pendingPauseTriggers: triggers.length > 0 ? Object.freeze([...triggers]) : undefined, forks: Object.freeze(Array.from(entriesByForkId.values())) }), pauseTriggers: Object.freeze(triggers) });
  } finally {
    for (const h of unreleasedHandles) await params.branchableScope.release(h);
  }
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
  const perForkOutputs: unknown[] = [];
  const persistEntryUpdate = async (updated: ForkBatchEntryRecord): Promise<void> => {
    entriesByForkId.set(updated.forkId, updated);
    const frame: ForkBatchContinuationFrame = Object.freeze({ kind: 'fork-batch-frame', parentStepExecId: params.ctx.stepExecId, forks: Object.freeze(Array.from(entriesByForkId.values())) });
    await params.continuationQueue.enqueueUpdate(params.ctx.stepExecId, () => params.ledgerStore.updateContinuationStack(params.ctx.runId, params.ctx.stepExecId, Object.freeze([...params.outerFrames, frame])));
  };
  const runStep = params.executeChildStep ?? ((cNode, cIn, cCtx) => executeDefaultForkOrTournamentChild(cNode, cIn, { childCtx: cCtx, ledgerStore: params.ledgerStore, lessonStore: params.lessonStore, lockManager: params.lockManager, continuationQueue: params.continuationQueue, poolManager: params.poolManager, humanAdaptersById: params.humanAdaptersById }));
  for (const record of suspendedRecords) {
    if (req.action === 'abort') {
      perForkOutputs.push(await abortSuspendedForkRecord(params, record, persistEntryUpdate));
      continue;
    }
    const initialEntry: ForkBatchEntryRecord = params.existingBatchFrame?.forks.find((f) => f.suspendedForkId === record.suspendedForkId) ?? Object.freeze<ForkBatchEntryRecord>({
      forkId: record.forkId, suspendedForkId: record.suspendedForkId, callId: req.callId, toolName: record.forkToolName,
      activePartitions: record.activePartitions, status: 'RUNNING', conflictRetryCount: record.conflictRetryCount,
      conflictCheckArmed: record.conflictCheckArmed, suspensionEpoch: record.suspensionEpoch,
      syncedToParentCheckpoint: record.syncedToParentCheckpoint, syncResultJson: record.syncResultJson,
      resumeFrameInjected: record.resumeFrameInjected, childScopeCheckpoint: record.childScopeCheckpoint, continuationStack: record.continuationStack,
    });
    const settled = await resumeSuspendedForkEntry({ batchParams: { ...params, executeChildStep: runStep }, record, entry: initialEntry, resolutionSummary: req.resolutionSummary, persistEntryUpdate });
    perForkOutputs.push(JSON.parse(settled.toolResultJson ?? '{}'));
  }
  const resultPayload = req.suspendedForkIds.length === 1 && perForkOutputs.length === 1 ? perForkOutputs[0] : { action: req.action, results: perForkOutputs };
  const resultsMap = new Map<string, { readonly content: string; readonly isError: boolean }>([[req.callId, { content: JSON.stringify(resultPayload), isError: false }]]);
  const finalFrame: ForkBatchContinuationFrame = Object.freeze({ kind: 'fork-batch-frame', parentStepExecId: params.ctx.stepExecId, forks: Object.freeze(Array.from(entriesByForkId.values())) });
  return Object.freeze<ForkBatchExecutionResult>({ toolResultsByCallId: resultsMap, batchFrame: finalFrame, pauseTriggers: Object.freeze([]) });
}
