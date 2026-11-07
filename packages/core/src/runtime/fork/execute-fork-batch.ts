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
 * Resolves the child step executor for `params`, defaulting to `executeDefaultForkOrTournamentChild`.
 *
 * Wires `ledgerStore`, `lessonStore`, `lockManager`, `continuationQueue`, `poolManager`, and `humanAdaptersById`.
 *
 * @template THandle Runtime handle type of the active `BranchableScope`.
 *
 * @param {ForkBatchExecutionParams<THandle>} params - Fork batch execution parameters.
 *
 * @returns {NonNullable<ForkBatchExecutionParams<THandle>['executeChildStep']>} Resolved child step runner.
 */
function resolveForkChildStepRunner<THandle = unknown>(
  params: ForkBatchExecutionParams<THandle>,
): NonNullable<ForkBatchExecutionParams<THandle>['executeChildStep']> {
  if (params.executeChildStep !== undefined) {
    return params.executeChildStep;
  }
  return (childNode, childIn, childCtx) =>
    executeDefaultForkOrTournamentChild(childNode, childIn, {
      childCtx,
      ledgerStore: params.ledgerStore,
      lessonStore: params.lessonStore,
      lockManager: params.lockManager,
      continuationQueue: params.continuationQueue,
      poolManager: params.poolManager,
      humanAdaptersById: params.humanAdaptersById,
    });
}

/**
 * Creates the serialized `persistEntryUpdate` callback for a fork batch.
 *
 * Enqueues continuation stack updates through `params.continuationQueue` so concurrent child completions
 * never overwrite sibling entries (`SPEC.md` §3.7.2).
 *
 * @template THandle Runtime handle type of the active `BranchableScope`.
 *
 * @param {ForkBatchExecutionParams<THandle>} params          - Fork batch execution parameters.
 * @param {Map<string, ForkBatchEntryRecord>} entriesByForkId - Mutable fork entry records map.
 * @param {readonly PendingPauseTriggerRecord[]} [triggers]   - Optional pause triggers array.
 *
 * @returns {(updated: ForkBatchEntryRecord) => Promise<void>} Serialized continuation persistence callback.
 */
function createForkBatchEntryPersister<THandle = unknown>(
  params: ForkBatchExecutionParams<THandle>,
  entriesByForkId: Map<string, ForkBatchEntryRecord>,
  triggers?: readonly PendingPauseTriggerRecord[],
): (updated: ForkBatchEntryRecord) => Promise<void> {
  return async (updated: ForkBatchEntryRecord): Promise<void> => {
    entriesByForkId.set(updated.forkId, updated);
    const frame: ForkBatchContinuationFrame = Object.freeze<ForkBatchContinuationFrame>({
      kind: 'fork-batch-frame',
      parentStepExecId: params.ctx.stepExecId,
      pendingPauseTriggers:
        triggers !== undefined && triggers.length > 0 ? Object.freeze([...triggers]) : undefined,
      forks: Object.freeze(Array.from(entriesByForkId.values())),
    });
    await params.continuationQueue.enqueueUpdate(params.ctx.stepExecId, () =>
      params.ledgerStore.updateContinuationStack(
        params.ctx.runId,
        params.ctx.stepExecId,
        Object.freeze([...params.outerFrames, frame]),
      ),
    );
  };
}

/**
 * Builds the settled `ForkBatchExecutionResult` from `entriesByForkId` and `triggers`.
 *
 * Maps each `ForkBatchEntryRecord` to its `callId` tool result and freezes `batchFrame`.
 *
 * @template THandle Runtime handle type of the active `BranchableScope`.
 *
 * @param {ForkBatchExecutionParams<THandle>}         params          - Fork batch execution parameters.
 * @param {ReadonlyMap<string, ForkBatchEntryRecord>} entriesByForkId - Settled fork entry records map.
 * @param {readonly PendingPauseTriggerRecord[]}      triggers        - Settled pause triggers.
 *
 * @returns {ForkBatchExecutionResult} Frozen fork batch execution result.
 */
function buildForkBatchExecutionResult<THandle = unknown>(
  params: ForkBatchExecutionParams<THandle>,
  entriesByForkId: ReadonlyMap<string, ForkBatchEntryRecord>,
  triggers: readonly PendingPauseTriggerRecord[],
): ForkBatchExecutionResult {
  const entries = Array.from(entriesByForkId.values());
  const toolResultsByCallId = new Map<
    string,
    { readonly content: string; readonly isError: boolean }
  >();
  for (const entry of entries) {
    toolResultsByCallId.set(entry.callId, {
      content: entry.toolResultJson ?? '{}',
      isError: entry.status === 'FAILED',
    });
  }
  const batchFrame: ForkBatchContinuationFrame = Object.freeze<ForkBatchContinuationFrame>({
    kind: 'fork-batch-frame',
    parentStepExecId: params.ctx.stepExecId,
    pendingPauseTriggers: triggers.length > 0 ? Object.freeze([...triggers]) : undefined,
    forks: Object.freeze(entries),
  });
  return Object.freeze<ForkBatchExecutionResult>({
    toolResultsByCallId,
    batchFrame,
    pauseTriggers: Object.freeze([...triggers]),
  });
}

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
  const entriesByForkId = new Map<string, ForkBatchEntryRecord>();
  for (const existing of params.existingBatchFrame?.forks ?? []) {
    entriesByForkId.set(existing.forkId, existing);
  }
  const handlesByForkId = new Map<string, THandle>();
  const triggers: PendingPauseTriggerRecord[] = [
    ...(params.existingBatchFrame?.pendingPauseTriggers ?? []),
  ];
  const unreleasedHandles = new Set<THandle>();
  const persistEntryUpdate = createForkBatchEntryPersister(params, entriesByForkId, triggers);
  const prepared: Array<Awaited<ReturnType<typeof prepareForkCallContext<THandle>>>> = [];
  const outcomesByForkId = new Map<string, ChildForkExecutionOutcome<unknown>>();
  let batchHasInterrupt = false;
  try {
    for (const call of params.forkCalls ?? []) {
      const prep = await prepareForkCallContext(params, call, entriesByForkId);
      unreleasedHandles.add(prep.childHandle);
      handlesByForkId.set(call.forkId, prep.childHandle);
      prepared.push(prep);
    }
    const runStep = resolveForkChildStepRunner(params);
    const limit = pLimit(Math.max(1, prepared.length));
    const settledOutcomes = await Promise.all(
      prepared.map((prep) =>
        limit(() =>
          runStep(prep.call.capability.childExecutable, prep.childInput, prep.childCtx),
        ),
      ),
    );
    for (let idx = 0; idx < prepared.length; idx += 1) {
      const prep = prepared[idx];
      const outcome = settledOutcomes[idx];
      if (prep === undefined || outcome === undefined) {
        continue;
      }
      outcomesByForkId.set(prep.call.forkId, outcome);
      entriesByForkId.set(
        prep.call.forkId,
        Object.freeze<ForkBatchEntryRecord>({
          ...prep.entry,
          continuationStack: outcome.continuationStack,
        }),
      );
      if (outcome.status === 'interrupt-raised') {
        batchHasInterrupt = true;
      }
    }
    for (const prep of prepared) {
      const entry = entriesByForkId.get(prep.call.forkId);
      const outcome = outcomesByForkId.get(prep.call.forkId);
      if (entry === undefined || outcome === undefined) {
        continue;
      }
      const shouldCommitChild =
        outcome.status !== 'interrupt-raised' &&
        !(batchHasInterrupt && outcome.continuationStack.length > 0);
      if (shouldCommitChild) {
        unreleasedHandles.delete(prep.childHandle);
        await reconcileChildForkWithBounce({
          batchParams: { ...params, executeChildStep: runStep },
          entry,
          childHandle: prep.childHandle,
          childNode: prep.call.capability.childExecutable,
          childInput: prep.childInput,
          outcome,
          persistEntryUpdate,
        });
      } else if (outcome.status === 'interrupt-raised') {
        const barrier = await coordinateTurnBatchInterruptBarrier(params, entry, {
          ...outcome,
          childHandle: prep.childHandle,
          siblingEntries: Array.from(entriesByForkId.values()),
          handlesByForkId,
        });
        triggers.push(barrier.trigger);
        for (const updated of [barrier.updatedRaisingEntry, ...barrier.pausedSiblings]) {
          await persistEntryUpdate(updated);
        }
      }
    }
    return buildForkBatchExecutionResult(params, entriesByForkId, triggers);
  } finally {
    const settled = await Promise.allSettled(
      Array.from(unreleasedHandles, (handle) => params.branchableScope.release(handle)),
    );
    const firstRejected = settled.find(
      (res): res is PromiseRejectedResult => res.status === 'rejected',
    );
    if (firstRejected !== undefined) {
      throw firstRejected.reason;
    }
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
  if (req === undefined) {
    throw new Error(`executeResumeForkBatch requires resumeRequest in run '${params.ctx.runId}'.`);
  }
  const suspendedRecords = await params.ledgerStore.getSuspendedForks(params.ctx.runId, {
    forkIds: req.suspendedForkIds,
    parentStepExecId: params.ctx.stepExecId,
  });
  const entriesByForkId = new Map<string, ForkBatchEntryRecord>();
  const perForkOutputs: unknown[] = [];
  const persistEntryUpdate = createForkBatchEntryPersister(params, entriesByForkId);
  const runStep = resolveForkChildStepRunner(params);
  for (const record of suspendedRecords) {
    if (req.action === 'abort') {
      perForkOutputs.push(await abortSuspendedForkRecord(params, record, persistEntryUpdate));
      continue;
    }
    const initialEntry: ForkBatchEntryRecord =
      params.existingBatchFrame?.forks.find(
        (f) => f.suspendedForkId === record.suspendedForkId,
      ) ??
      Object.freeze<ForkBatchEntryRecord>({
        forkId: record.forkId,
        suspendedForkId: record.suspendedForkId,
        callId: req.callId,
        toolName: record.forkToolName,
        activePartitions: record.activePartitions,
        status: 'RUNNING',
        conflictRetryCount: record.conflictRetryCount,
        conflictCheckArmed: record.conflictCheckArmed,
        suspensionEpoch: record.suspensionEpoch,
        syncedToParentCheckpoint: record.syncedToParentCheckpoint,
        syncResultJson: record.syncResultJson,
        resumeFrameInjected: record.resumeFrameInjected,
        childScopeCheckpoint: record.childScopeCheckpoint,
        continuationStack: record.continuationStack,
      });
    const settled = await resumeSuspendedForkEntry({
      batchParams: { ...params, executeChildStep: runStep },
      record,
      entry: initialEntry,
      resolutionSummary: req.resolutionSummary,
      persistEntryUpdate,
    });
    perForkOutputs.push(JSON.parse(settled.toolResultJson ?? '{}'));
  }
  const resultPayload =
    req.suspendedForkIds.length === 1 && perForkOutputs.length === 1
      ? perForkOutputs[0]
      : { action: req.action, results: perForkOutputs };
  const resultsMap = new Map<
    string,
    { readonly content: string; readonly isError: boolean }
  >([[req.callId, { content: JSON.stringify(resultPayload), isError: false }]]);
  const finalFrame: ForkBatchContinuationFrame = Object.freeze({
    kind: 'fork-batch-frame',
    parentStepExecId: params.ctx.stepExecId,
    forks: Object.freeze(Array.from(entriesByForkId.values())),
  });
  return Object.freeze<ForkBatchExecutionResult>({
    toolResultsByCallId: resultsMap,
    batchFrame: finalFrame,
    pauseTriggers: Object.freeze([]),
  });
}
