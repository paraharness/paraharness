import type { AgentContinuationFrame } from '../../../ports/agent-continuation-frame.js';
import type { ContinuationFrame } from '../../../ports/continuation-frame.types.js';
import type { ForkBatchEntryRecord } from '../../../ports/fork-batch-continuation-frame.js';
import type { LeaseDelta } from '../../../ports/lease-delta.js';
import type { LoopContinuationFrame } from '../../../ports/loop-continuation-frame.js';
import type { WireFrameRecord } from '../../../ports/wire-frame-record.js';
import type { ResumeSuspendedForkEntryParams } from '../fork-batch-execution-params.js';
import { reconcileChildForkWithBounce } from './fork-barrier-and-pause.js';

/**
 * Injects the Case A (`INTERRUPT_RAISED`) resumption frame or tool result (`SPEC.md` §3.7.2).
 *
 * Pairs `suspendedAtCallId` in `completedResults` when raised from an `.act()` tool call, or appends
 * a synthetic `user` frame at `preservedActLeafMessageId` when raised by `.evaluate()`.
 *
 * @template THandle Runtime handle type of the active `BranchableScope`.
 *
 * @param {ResumeSuspendedForkEntryParams<THandle>} params     - Resume parameters and suspended fork record.
 * @param {string}                                  syncDigest - Formatted `[PARENT_SYNC]` note string.
 *
 * @returns {Promise<readonly ContinuationFrame[]>} Updated child continuation stack with Case A frame injected.
 */
export async function injectCaseAResumeFrame<THandle = unknown>(
  params: ResumeSuspendedForkEntryParams<THandle>,
  syncDigest: string,
): Promise<readonly ContinuationFrame[]> {
  const { batchParams, record, resolutionSummary } = params;
  const noteText = `[INTERRUPT_RESOLVED] ${resolutionSummary}\n${syncDigest}`;
  const out: ContinuationFrame[] = [];
  for (const frame of params.entry.continuationStack) {
    if (frame.kind === 'agent-frame') {
      if (record.raisedByPhase !== 'evaluate' && record.suspendedAtCallId !== undefined && frame.pauseState.kind === 'tool-batch') {
        const batch = frame.pauseState.pendingToolBatch;
        const completed = Object.freeze([...batch.completedResults, Object.freeze({ callId: record.suspendedAtCallId, content: noteText, isError: false })]);
        const remaining = batch.remainingCalls.filter((c) => c.callId !== record.suspendedAtCallId);
        out.push(Object.freeze<AgentContinuationFrame>({ ...frame, pauseState: Object.freeze({ ...frame.pauseState, pendingToolBatch: Object.freeze({ ...batch, completedResults: completed, activeInterruptCallId: undefined, remainingCalls: Object.freeze(remaining) }) }) }));
      } else {
        const msgId = `msg:${record.suspendedForkId}:case-a`;
        await batchParams.ledgerStore.appendMessageFrame(batchParams.ctx.runId, Object.freeze<WireFrameRecord>({ messageId: msgId, parentMessageId: frame.leafMessageId, vendorId: batchParams.modelDriver?.vendorId ?? 'anthropic', rawWireFrame: new TextEncoder().encode(noteText), canonical: Object.freeze({ role: 'user', visibleText: noteText }), prefixDigest: batchParams.wirePrefix?.systemDigest ?? 'unpinned' }));
        out.push(Object.freeze<AgentContinuationFrame>({ ...frame, leafMessageId: msgId, pausedAtPhase: 'TOOL_BOUNDARY', pauseState: Object.freeze({ kind: 'active-turn' }) }));
      }
    } else out.push(frame);
  }
  return Object.freeze(out);
}

/**
 * Injects the Case B (`PAUSED_BY_SIBLING_INTERRUPT` at `TOOL_BOUNDARY`) resumption notes (`SPEC.md` §3.7.2).
 *
 * Appends `[SIBLING_INTERRUPT_RESUME]` and `[PARENT_SYNC]` onto the child's trailing `tool` or `user` frame
 * via `ModelDriver.appendToolResultNotes` (or appends a synthetic user frame when trailing is assistant).
 *
 * @template THandle Runtime handle type of the active `BranchableScope`.
 *
 * @param {ResumeSuspendedForkEntryParams<THandle>} params     - Resume parameters and suspended fork record.
 * @param {string}                                  syncDigest - Formatted `[PARENT_SYNC]` note string.
 *
 * @returns {Promise<readonly ContinuationFrame[]>} Updated child continuation stack with Case B notes injected.
 */
export async function injectCaseBResumeFrame<THandle = unknown>(
  params: ResumeSuspendedForkEntryParams<THandle>,
  syncDigest: string,
): Promise<readonly ContinuationFrame[]> {
  const { batchParams, record, resolutionSummary } = params;
  const noteText = `[SIBLING_INTERRUPT_RESUME] ${resolutionSummary}\n${syncDigest}`;
  const out: ContinuationFrame[] = [];
  for (const frame of params.entry.continuationStack) {
    if (frame.kind === 'agent-frame') {
      const chain = frame.leafMessageId !== null ? await batchParams.ledgerStore.getMessageChain(frame.leafMessageId) : [];
      const last = chain[chain.length - 1];
      if (last !== undefined && batchParams.modelDriver !== undefined && (last.canonical.role === 'tool' || last.canonical.role === 'user')) {
        const updated = await batchParams.modelDriver.appendToolResultNotes(last, [noteText]);
        await batchParams.ledgerStore.replaceMessageFrame(batchParams.ctx.runId, updated);
        out.push(frame);
      } else {
        const msgId = `msg:${record.suspendedForkId}:case-b`;
        await batchParams.ledgerStore.appendMessageFrame(batchParams.ctx.runId, Object.freeze<WireFrameRecord>({ messageId: msgId, parentMessageId: frame.leafMessageId, vendorId: batchParams.modelDriver?.vendorId ?? 'anthropic', rawWireFrame: new TextEncoder().encode(noteText), canonical: Object.freeze({ role: 'user', visibleText: noteText }), prefixDigest: batchParams.wirePrefix?.systemDigest ?? 'unpinned' }));
        out.push(Object.freeze<AgentContinuationFrame>({ ...frame, leafMessageId: msgId }));
      }
    } else out.push(frame);
  }
  return Object.freeze(out);
}

/**
 * Injects the Case C (`PAUSED_BY_SIBLING_INTERRUPT` at `BEFORE_STOP_GATE`) resumption frame (`SPEC.md` §3.7.2).
 *
 * Appends `[TOPOLOGY_SYNC_REVERIFY]` and `[PARENT_SYNC]` and sets `neutralSyncContinuation: true`
 * on the child's `agent-frame` so `beforeStop` re-verifies against the rebased scope state.
 *
 * @template THandle Runtime handle type of the active `BranchableScope`.
 *
 * @param {ResumeSuspendedForkEntryParams<THandle>} params     - Resume parameters and suspended fork record.
 * @param {string}                                  syncDigest - Formatted `[PARENT_SYNC]` note string.
 *
 * @returns {Promise<readonly ContinuationFrame[]>} Updated child continuation stack with `neutralSyncContinuation: true`.
 */
export async function injectCaseCResumeFrame<THandle = unknown>(
  params: ResumeSuspendedForkEntryParams<THandle>,
  syncDigest: string,
): Promise<readonly ContinuationFrame[]> {
  const { batchParams, record, resolutionSummary } = params;
  const noteText = `[TOPOLOGY_SYNC_REVERIFY] ${resolutionSummary}\n${syncDigest}`;
  const out: ContinuationFrame[] = [];
  for (const frame of params.entry.continuationStack) {
    if (frame.kind === 'agent-frame') {
      const msgId = `msg:${record.suspendedForkId}:case-c`;
      await batchParams.ledgerStore.appendMessageFrame(batchParams.ctx.runId, Object.freeze<WireFrameRecord>({ messageId: msgId, parentMessageId: frame.leafMessageId, vendorId: batchParams.modelDriver?.vendorId ?? 'anthropic', rawWireFrame: new TextEncoder().encode(noteText), canonical: Object.freeze({ role: 'user', visibleText: noteText }), prefixDigest: batchParams.wirePrefix?.systemDigest ?? 'unpinned' }));
      out.push(Object.freeze<AgentContinuationFrame>({ ...frame, leafMessageId: msgId, neutralSyncContinuation: true, pausedAtPhase: 'TOOL_BOUNDARY', pauseState: Object.freeze({ kind: 'active-turn' }) }));
    } else out.push(frame);
  }
  return Object.freeze(out);
}

/**
 * Resumes a single `SuspendedForkRecord` with replay-idempotent `restoreCheckpoint` + `syncChild`, Case A/B/C injection, and atomic `resolveSuspendedFork` (`SPEC.md` §3.7.2).
 *
 * Reattaches the child scope handle, synchronizes against `parentHandle`, runs `executeChildStep` and
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
  const forkCap = batchParams.parentNode.capabilities?.forks.find((f) => f.toolName === record.forkToolName);
  if (forkCap === undefined) throw new Error(`Unknown fork tool '${record.forkToolName}' on parent '${batchParams.parentNode.id}'.`);
  const childHandle = await batchParams.lockManager.withReadLock(batchParams.ctx.scopeHandle, () => batchParams.branchableScope.reattachChild(batchParams.ctx.scopeHandle, record.forkId, record.childScopeCheckpoint));
  let curEntry = params.entry, conflictLease: LeaseDelta | undefined;
  if (curEntry.syncedToParentCheckpoint === undefined) {
    if (record.childScopeCheckpoint !== undefined) await batchParams.branchableScope.restoreCheckpoint(childHandle, record.childScopeCheckpoint);
    const syncRes = await batchParams.lockManager.withReadLock(batchParams.ctx.scopeHandle, () => batchParams.branchableScope.syncChild(batchParams.ctx.scopeHandle, childHandle));
    if (syncRes.status === 'conflict') conflictLease = batchParams.branchableScope.getConflictLease?.(childHandle);
    const syncedCkpt = await batchParams.branchableScope.serializeCheckpoint(childHandle);
    const updatedStack = curEntry.continuationStack.map((f) => f.kind === 'agent-frame' && conflictLease !== undefined ? Object.freeze<AgentContinuationFrame>({ ...f, conflictCheckArmed: true, activeLeases: Object.freeze([...f.activeLeases, conflictLease]) }) : f.kind === 'loop-frame' && conflictLease !== undefined ? Object.freeze<LoopContinuationFrame>({ ...f, conflictCheckArmed: true, grantedLoopLeases: Object.freeze([...f.grantedLoopLeases, conflictLease]) }) : f);
    curEntry = Object.freeze<ForkBatchEntryRecord>({ ...curEntry, conflictCheckArmed: curEntry.conflictCheckArmed || syncRes.status === 'conflict', syncedToParentCheckpoint: syncedCkpt, syncResultJson: JSON.stringify(syncRes), continuationStack: Object.freeze(updatedStack) });
    await params.persistEntryUpdate(curEntry);
  }
  if (curEntry.resumeFrameInjected !== true) {
    const syncNote = `[PARENT_SYNC] ${curEntry.syncResultJson ?? '{}'}`;
    const innerAgent = curEntry.continuationStack.find((f): f is AgentContinuationFrame => f.kind === 'agent-frame');
    const nextStack = record.suspensionReason === 'INTERRUPT_RAISED' ? await injectCaseAResumeFrame({ ...params, entry: curEntry }, syncNote) : innerAgent?.pausedAtPhase === 'BEFORE_STOP_GATE' ? await injectCaseCResumeFrame({ ...params, entry: curEntry }, syncNote) : await injectCaseBResumeFrame({ ...params, entry: curEntry }, syncNote);
    curEntry = Object.freeze<ForkBatchEntryRecord>({ ...curEntry, resumeFrameInjected: true, continuationStack: nextStack });
    await params.persistEntryUpdate(curEntry);
  }
  const innerInputJson = curEntry.continuationStack.find((f): f is AgentContinuationFrame => f.kind === 'agent-frame')?.inputJson ?? curEntry.continuationStack.find((f): f is LoopContinuationFrame => f.kind === 'loop-frame')?.loopInputJson ?? 'null';
  const outcome = await batchParams.executeChildStep(forkCap.childExecutable, JSON.parse(innerInputJson), Object.freeze({ ...batchParams.ctx, scopeHandle: childHandle, activePartitions: curEntry.activePartitions, resumeContinuationStack: curEntry.continuationStack }));
  const settled = await reconcileChildForkWithBounce({ batchParams, entry: curEntry, childHandle, childNode: forkCap.childExecutable, childInput: JSON.parse(innerInputJson), outcome, persistEntryUpdate: params.persistEntryUpdate });
  await batchParams.ledgerStore.resolveSuspendedFork(record.suspendedForkId, 'RESUMED');
  return settled;
}
