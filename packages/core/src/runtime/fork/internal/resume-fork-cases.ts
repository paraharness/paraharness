import type { AgentContinuationFrame } from '../../../ports/agent-continuation-frame.js';
import type { ContinuationFrame } from '../../../ports/continuation-frame.types.js';
import type { ForkBatchEntryRecord } from '../../../ports/fork-batch-continuation-frame.js';
import type { LeaseDelta } from '../../../ports/lease-delta.js';
import type { LoopContinuationFrame } from '../../../ports/loop-continuation-frame.js';
import type { WireFrameRecord } from '../../../ports/wire-frame-record.js';
import type { ResumeSuspendedForkEntryParams } from '../resume-suspended-fork-entry-params.js';
import { reconcileChildForkWithBounce } from './fork-barrier-and-pause.js';
import { executeDefaultForkOrTournamentChild } from './run-single-fork-call.js';

/**
 * Injects the Case A (`INTERRUPT_RAISED`) resumption frame or tool result (`SPEC.md` §3.7.2).
 *
 * Pairs `suspendedAtCallId` in `completedResults` with `{ resolutionSummary, parentSyncResult }` when raised from an `.act()` tool call,
 * or appends `[CONTRACT_VIOLATION_RESOLVED]` + `[TOPOLOGY_SYNC]` at `preservedActLeafMessageId` when raised by `.evaluate()`.
 *
 * @template THandle Runtime handle type of the active `BranchableScope`.
 *
 * @param {ResumeSuspendedForkEntryParams<THandle>} params     - Resume parameters and suspended fork record.
 * @param {string}                                  syncDigest - Serialized parent sync result JSON string.
 *
 * @returns {Promise<readonly ContinuationFrame[]>} Updated child continuation stack with Case A frame injected.
 */
export async function injectCaseAResumeFrame<THandle = unknown>(
  params: ResumeSuspendedForkEntryParams<THandle>,
  syncDigest: string,
): Promise<readonly ContinuationFrame[]> {
  const { batchParams, record, resolutionSummary } = params;
  const evalNote = `[CONTRACT_VIOLATION_RESOLVED]: Original Deficit: ${record.interruptPayloadJson ?? '{}'}. Parent Resolution: ${resolutionSummary}\n[TOPOLOGY_SYNC]: ${syncDigest}`;
  const msgId = `msg:${record.suspendedForkId}:case-a`;
  let frameAppended = false;
  const out: ContinuationFrame[] = [];
  for (const frame of params.entry.continuationStack) {
    if (frame.kind === 'agent-frame') {
      if (
        record.raisedByPhase !== 'evaluate' &&
        record.suspendedAtCallId !== undefined &&
        frame.pauseState.kind === 'tool-batch'
      ) {
        const batch = frame.pauseState.pendingToolBatch;
        const toolContent = JSON.stringify({
          resolutionSummary,
          parentSyncResult: JSON.parse(syncDigest || '{}'),
        });
        const completed = Object.freeze([
          ...batch.completedResults,
          Object.freeze({
            callId: record.suspendedAtCallId,
            content: toolContent,
            isError: false,
          }),
        ]);
        const remaining = batch.remainingCalls.filter(
          (c) => c.callId !== record.suspendedAtCallId,
        );
        out.push(
          Object.freeze<AgentContinuationFrame>({
            ...frame,
            pauseState: Object.freeze({
              ...frame.pauseState,
              pendingToolBatch: Object.freeze({
                ...batch,
                completedResults: completed,
                activeInterruptCallId: undefined,
                remainingCalls: Object.freeze(remaining),
              }),
            }),
          }),
        );
      } else {
        await batchParams.ledgerStore.appendMessageFrame(
          batchParams.ctx.runId,
          Object.freeze<WireFrameRecord>({
            messageId: msgId,
            parentMessageId: frame.leafMessageId,
            vendorId: batchParams.modelDriver?.vendorId ?? 'anthropic',
            rawWireFrame: new TextEncoder().encode(evalNote),
            canonical: Object.freeze({ role: 'user', visibleText: evalNote }),
            prefixDigest: batchParams.wirePrefix?.systemDigest ?? 'unpinned',
          }),
        );
        frameAppended = true;
        out.push(
          Object.freeze<AgentContinuationFrame>({
            ...frame,
            leafMessageId: msgId,
            pausedAtPhase: 'TOOL_BOUNDARY',
            pauseState: Object.freeze({ kind: 'active-turn' }),
          }),
        );
      }
    } else if (frame.kind === 'loop-frame' && record.raisedByPhase === 'evaluate') {
      if (!frameAppended) {
        await batchParams.ledgerStore.appendMessageFrame(
          batchParams.ctx.runId,
          Object.freeze<WireFrameRecord>({
            messageId: msgId,
            parentMessageId: frame.preservedActLeafMessageId,
            vendorId: batchParams.modelDriver?.vendorId ?? 'anthropic',
            rawWireFrame: new TextEncoder().encode(evalNote),
            canonical: Object.freeze({ role: 'user', visibleText: evalNote }),
            prefixDigest: batchParams.wirePrefix?.systemDigest ?? 'unpinned',
          }),
        );
        frameAppended = true;
      }
      out.push(
        Object.freeze<LoopContinuationFrame>({
          ...frame,
          phase: 'act',
          preservedActLeafMessageId: msgId,
        }),
      );
    } else {
      out.push(frame);
    }
  }
  return Object.freeze(out);
}

/**
 * Injects the Case B (`PAUSED_BY_SIBLING_INTERRUPT` at `TOOL_BOUNDARY`) resumption notes (`SPEC.md` §3.7.2).
 *
 * Appends `[TOPOLOGY_SYNC]` onto the child's trailing `tool` or `user` frame via `ModelDriver.appendToolResultNotes`
 * (or appends a synthetic user frame when trailing is assistant).
 *
 * @template THandle Runtime handle type of the active `BranchableScope`.
 *
 * @param {ResumeSuspendedForkEntryParams<THandle>} params     - Resume parameters and suspended fork record.
 * @param {string}                                  syncDigest - Serialized parent sync result JSON string.
 *
 * @returns {Promise<readonly ContinuationFrame[]>} Updated child continuation stack with Case B notes injected.
 */
export async function injectCaseBResumeFrame<THandle = unknown>(
  params: ResumeSuspendedForkEntryParams<THandle>,
  syncDigest: string,
): Promise<readonly ContinuationFrame[]> {
  const { batchParams, record, resolutionSummary } = params;
  const noteText = `[TOPOLOGY_SYNC]: ${resolutionSummary}\n${syncDigest}`;
  const out: ContinuationFrame[] = [];
  for (const frame of params.entry.continuationStack) {
    if (frame.kind !== 'agent-frame') {
      out.push(frame);
      continue;
    }
    const chain =
      frame.leafMessageId !== null
        ? await batchParams.ledgerStore.getMessageChain(frame.leafMessageId)
        : [];
    const last = chain[chain.length - 1];
    if (
      last !== undefined &&
      batchParams.modelDriver !== undefined &&
      (last.canonical.role === 'tool' || last.canonical.role === 'user')
    ) {
      const updated = await batchParams.modelDriver.appendToolResultNotes(last, [noteText]);
      await batchParams.ledgerStore.replaceMessageFrame(batchParams.ctx.runId, updated);
      out.push(
        Object.freeze<AgentContinuationFrame>({
          ...frame,
          pauseState: Object.freeze({ kind: 'active-turn' }),
        }),
      );
    } else {
      const msgId = `msg:${record.suspendedForkId}:case-b`;
      await batchParams.ledgerStore.appendMessageFrame(
        batchParams.ctx.runId,
        Object.freeze<WireFrameRecord>({
          messageId: msgId,
          parentMessageId: frame.leafMessageId,
          vendorId: batchParams.modelDriver?.vendorId ?? 'anthropic',
          rawWireFrame: new TextEncoder().encode(noteText),
          canonical: Object.freeze({ role: 'user', visibleText: noteText }),
          prefixDigest: batchParams.wirePrefix?.systemDigest ?? 'unpinned',
        }),
      );
      out.push(
        Object.freeze<AgentContinuationFrame>({
          ...frame,
          leafMessageId: msgId,
          pauseState: Object.freeze({ kind: 'active-turn' }),
        }),
      );
    }
  }
  return Object.freeze(out);
}

/**
 * Injects the Case C (`PAUSED_BY_SIBLING_INTERRUPT` at `BEFORE_STOP_GATE`) resumption frame (`SPEC.md` §3.7.2).
 *
 * Appends `[TOPOLOGY_SYNC_REVERIFY]: Upstream contract updated (...)` + `[TOPOLOGY_SYNC]` and sets `neutralSyncContinuation: true`
 * on the child's `agent-frame` so `beforeStop` re-verifies against the rebased scope state.
 *
 * @template THandle Runtime handle type of the active `BranchableScope`.
 *
 * @param {ResumeSuspendedForkEntryParams<THandle>} params     - Resume parameters and suspended fork record.
 * @param {string}                                  syncDigest - Serialized parent sync result JSON string.
 *
 * @returns {Promise<readonly ContinuationFrame[]>} Updated child continuation stack with `neutralSyncContinuation: true`.
 */
export async function injectCaseCResumeFrame<THandle = unknown>(
  params: ResumeSuspendedForkEntryParams<THandle>,
  syncDigest: string,
): Promise<readonly ContinuationFrame[]> {
  const { batchParams, record, resolutionSummary } = params;
  const noteText = `[TOPOLOGY_SYNC_REVERIFY]: Upstream contract updated (${resolutionSummary}). Re-verify output against updated scope before completing.\n[TOPOLOGY_SYNC]: ${syncDigest}`;
  const out: ContinuationFrame[] = [];
  for (const frame of params.entry.continuationStack) {
    if (frame.kind === 'agent-frame') {
      const msgId = `msg:${record.suspendedForkId}:case-c`;
      await batchParams.ledgerStore.appendMessageFrame(
        batchParams.ctx.runId,
        Object.freeze<WireFrameRecord>({
          messageId: msgId,
          parentMessageId: frame.leafMessageId,
          vendorId: batchParams.modelDriver?.vendorId ?? 'anthropic',
          rawWireFrame: new TextEncoder().encode(noteText),
          canonical: Object.freeze({ role: 'user', visibleText: noteText }),
          prefixDigest: batchParams.wirePrefix?.systemDigest ?? 'unpinned',
        }),
      );
      out.push(
        Object.freeze<AgentContinuationFrame>({
          ...frame,
          leafMessageId: msgId,
          neutralSyncContinuation: true,
          pausedAtPhase: 'TOOL_BOUNDARY',
          pauseState: Object.freeze({ kind: 'active-turn' }),
        }),
      );
    } else {
      out.push(frame);
    }
  }
  return Object.freeze(out);
}

/**
 * Synchronizes a suspended child scope against `parentHandle` under a write lock if not already synced (`SPEC.md` §3.7.2).
 *
 * Restores `record.childScopeCheckpoint`, runs `syncChild`, and persists `syncedToParentCheckpoint` and `syncResultJson`.
 *
 * @template THandle Runtime handle type of the active `BranchableScope`.
 *
 * @param {ResumeSuspendedForkEntryParams<THandle>} params      - Resume entry parameters.
 * @param {ForkBatchEntryRecord}                    curEntry    - Current fork batch entry record.
 * @param {THandle}                                 childHandle - Reattached child scope handle.
 *
 * @returns {Promise<ForkBatchEntryRecord>} Updated entry record with `syncedToParentCheckpoint` populated.
 */
async function syncSuspendedChildScopeIfNeeded<THandle = unknown>(
  params: ResumeSuspendedForkEntryParams<THandle>,
  curEntry: ForkBatchEntryRecord,
  childHandle: THandle,
): Promise<ForkBatchEntryRecord> {
  if (curEntry.syncedToParentCheckpoint !== undefined) {
    return curEntry;
  }
  const { batchParams, record } = params;
  const syncOut = await batchParams.lockManager.withWriteLock(
    batchParams.ctx.scopeHandle,
    async () => {
      if (record.childScopeCheckpoint !== undefined) {
        await batchParams.branchableScope.restoreCheckpoint(
          childHandle,
          record.childScopeCheckpoint,
        );
      }
      const syncRes = await batchParams.branchableScope.syncChild(
        batchParams.ctx.scopeHandle,
        childHandle,
      );
      return {
        syncRes,
        syncedCkpt: await batchParams.branchableScope.serializeCheckpoint(childHandle),
      };
    },
    batchParams.ctx.signal,
  );
  const conflictLease: LeaseDelta | undefined =
    syncOut.syncRes.status === 'conflict'
      ? batchParams.branchableScope.getConflictLease?.(childHandle)
      : undefined;
  const updatedStack: ContinuationFrame[] = [];
  for (const f of curEntry.continuationStack) {
    if (f.kind === 'agent-frame' && conflictLease !== undefined) {
      updatedStack.push(
        Object.freeze<AgentContinuationFrame>({
          ...f,
          conflictCheckArmed: true,
          activeLeases: Object.freeze([...f.activeLeases, conflictLease]),
        }),
      );
    } else if (f.kind === 'loop-frame' && conflictLease !== undefined) {
      updatedStack.push(
        Object.freeze<LoopContinuationFrame>({
          ...f,
          conflictCheckArmed: true,
          grantedLoopLeases: Object.freeze([...f.grantedLoopLeases, conflictLease]),
        }),
      );
    } else {
      updatedStack.push(f);
    }
  }
  const updatedEntry = Object.freeze<ForkBatchEntryRecord>({
    ...curEntry,
    conflictCheckArmed: curEntry.conflictCheckArmed || syncOut.syncRes.status === 'conflict',
    syncedToParentCheckpoint: syncOut.syncedCkpt,
    syncResultJson: JSON.stringify(syncOut.syncRes),
    continuationStack: Object.freeze(updatedStack),
  });
  await params.persistEntryUpdate(updatedEntry);
  return updatedEntry;
}

/**
 * Resumes a single `SuspendedForkRecord` with write-locked replay-idempotent `restoreCheckpoint` + `syncChild`, Case A/B/C injection, and atomic `resolveSuspendedFork` (`SPEC.md` §3.7.2).
 *
 * Reattaches the child scope handle, synchronizes against `parentHandle` under a write lock, runs `executeChildStep` and
 * `reconcileChildForkWithBounce`, and marks `${forkId}#${suspensionEpoch}` as `'RESUMED'`.
 *
 * @template THandle Runtime handle type of the active `BranchableScope`.
 *
 * @param {ResumeSuspendedForkEntryParams<THandle>} params - Resume entry parameters and suspended record.
 *
 * @returns {Promise<ForkBatchEntryRecord>} Settled `ForkBatchEntryRecord` after resumption.
 */
export async function resumeSuspendedForkEntry<THandle = unknown>(
  params: ResumeSuspendedForkEntryParams<THandle>,
): Promise<ForkBatchEntryRecord> {
  const { batchParams, record } = params;
  const forkCap = batchParams.parentNode.capabilities?.forks.find(
    (f) => f.toolName === record.forkToolName,
  );
  if (forkCap === undefined) {
    throw new Error(
      `Unknown fork tool '${record.forkToolName}' on parent '${batchParams.parentNode.id}'.`,
    );
  }
  const childHandle = await batchParams.lockManager.withReadLock(
    batchParams.ctx.scopeHandle,
    () =>
      batchParams.branchableScope.reattachChild(
        batchParams.ctx.scopeHandle,
        record.forkId,
        record.childScopeCheckpoint,
      ),
    batchParams.ctx.signal,
  );
  let handedOffToReconcile = false;
  let curEntry = params.entry;
  try {
    curEntry = await syncSuspendedChildScopeIfNeeded(params, curEntry, childHandle);
    if (curEntry.resumeFrameInjected !== true) {
      const syncJson = curEntry.syncResultJson ?? '{}';
      const innerAgent = curEntry.continuationStack.find(
        (f): f is AgentContinuationFrame => f.kind === 'agent-frame',
      );
      let nextStack: readonly ContinuationFrame[];
      if (record.suspensionReason === 'INTERRUPT_RAISED') {
        nextStack = await injectCaseAResumeFrame({ ...params, entry: curEntry }, syncJson);
      } else if (innerAgent?.pausedAtPhase === 'BEFORE_STOP_GATE') {
        nextStack = await injectCaseCResumeFrame({ ...params, entry: curEntry }, syncJson);
      } else {
        nextStack = await injectCaseBResumeFrame({ ...params, entry: curEntry }, syncJson);
      }
      curEntry = Object.freeze<ForkBatchEntryRecord>({
        ...curEntry,
        resumeFrameInjected: true,
        continuationStack: nextStack,
      });
      await params.persistEntryUpdate(curEntry);
    }
    const runStep =
      batchParams.executeChildStep ??
      ((cNode, cIn, cCtx) =>
        executeDefaultForkOrTournamentChild(cNode, cIn, {
          childCtx: cCtx,
          ledgerStore: batchParams.ledgerStore,
          lessonStore: batchParams.lessonStore,
          lockManager: batchParams.lockManager,
          continuationQueue: batchParams.continuationQueue,
          poolManager: batchParams.poolManager,
          humanAdaptersById: batchParams.humanAdaptersById,
        }));
    const innerInputJson =
      curEntry.continuationStack.find((f): f is AgentContinuationFrame => f.kind === 'agent-frame')
        ?.inputJson ??
      curEntry.continuationStack.find((f): f is LoopContinuationFrame => f.kind === 'loop-frame')
        ?.loopInputJson ??
      'null';
    const childInput: unknown = JSON.parse(innerInputJson);
    const outcome = await runStep(
      forkCap.childExecutable,
      childInput,
      Object.freeze({
        ...batchParams.ctx,
        stepExecId: `${batchParams.ctx.stepExecId}:fork:${record.forkId}`,
        scopeHandle: childHandle,
        activePartitions: curEntry.activePartitions,
        resumeContinuationStack: curEntry.continuationStack,
      }),
    );
    handedOffToReconcile = true;
    const settled = await reconcileChildForkWithBounce({
      batchParams: { ...batchParams, executeChildStep: runStep },
      entry: curEntry,
      childHandle,
      childNode: forkCap.childExecutable,
      childInput,
      outcome,
      persistEntryUpdate: params.persistEntryUpdate,
    });
    await batchParams.ledgerStore.resolveSuspendedFork(record.suspendedForkId, 'RESUMED');
    return settled;
  } finally {
    if (!handedOffToReconcile) {
      await batchParams.branchableScope.release(childHandle);
    }
  }
}
