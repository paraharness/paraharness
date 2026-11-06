import type { AgentContinuationFrame } from '../../../ports/agent-continuation-frame.js';
import type { ContinuationFrame } from '../../../ports/continuation-frame.types.js';
import type {
  ForkBatchEntryRecord,
  PendingPauseTriggerRecord,
} from '../../../ports/fork-batch-continuation-frame.js';
import type { LoopContinuationFrame } from '../../../ports/loop-continuation-frame.js';
import type { SuspendedForkRecord } from '../../../ports/suspended-fork-record.js';
import type { WireFrameRecord } from '../../../ports/wire-frame-record.js';
import type {
  ForkBatchExecutionParams,
  PauseSiblingBarrierContext,
  ReconcileChildForkParams,
  TurnBatchBarrierContext,
  TurnBatchBarrierResult,
} from '../fork-batch-execution-params.js';

/**
 * Rolls back an evaluator-raised upward interrupt to `.act()` at `preservedActLeafMessageId` (`SPEC.md` §3.7.2).
 *
 * Ensures that when `resumeFork` resumes a child `H.loop` whose `.evaluate()` raised an interrupt,
 * the write-capable `.act()` worker resumes from its preserved completion leaf rather than the read-only evaluator.
 *
 * @param {readonly ContinuationFrame[]}    stack       - Child continuation stack at the moment the interrupt was raised.
 * @param {'act' | 'evaluate' | undefined}  raisedPhase - Phase that raised the upward interrupt.
 *
 * @returns {readonly ContinuationFrame[]} Normalized continuation stack anchored on the `.act()` worker.
 */
export function normalizeEvaluatorRollbackStack(
  stack: readonly ContinuationFrame[],
  raisedPhase: 'act' | 'evaluate' | undefined,
): readonly ContinuationFrame[] {
  if (raisedPhase !== 'evaluate') return stack;
  const out: ContinuationFrame[] = [];
  for (const frame of stack) {
    if (frame.kind === 'loop-frame') {
      out.push(Object.freeze<LoopContinuationFrame>({ ...frame, phase: 'act' }));
    } else if (frame.kind === 'agent-frame') {
      const parentLoop = out.find((f): f is LoopContinuationFrame => f.kind === 'loop-frame');
      out.push(Object.freeze<AgentContinuationFrame>({
        ...frame,
        agentId: parentLoop !== undefined ? parentLoop.roleKey : frame.agentId,
        roleKey: parentLoop !== undefined ? parentLoop.roleKey : frame.roleKey,
        leafMessageId: parentLoop?.preservedActLeafMessageId ?? frame.leafMessageId,
        pausedAtPhase: 'BEFORE_STOP_GATE',
        pauseState: Object.freeze({ kind: 'before-stop-gate' }),
      }));
    } else out.push(frame);
  }
  return Object.freeze(out);
}

/**
 * Pauses a sibling fork at its `TOOL_BOUNDARY` (Case B) or `BEFORE_STOP_GATE` (Case C) during a turn-batch barrier (`SPEC.md` §3.7.2).
 *
 * Cancels any pending exogenous `HumanAdapter.requestDecision()` call via `cancelDecision(humanRequestId)`,
 * snapshots `childScopeCheckpoint`, and persists the `SuspendedForkRecord` in `LedgerStore`.
 *
 * @template THandle Runtime handle type of the active `BranchableScope`.
 *
 * @param {ForkBatchExecutionParams<THandle>}   batchParams       - Enclosing fork batch execution parameters.
 * @param {ForkBatchEntryRecord}                siblingEntry      - Sibling fork entry being paused.
 * @param {PauseSiblingBarrierContext<THandle>} triggerWithHandle - Trigger metadata and sibling scope handle.
 *
 * @returns {Promise<ForkBatchEntryRecord>} Updated sibling `ForkBatchEntryRecord` in `'SUSPENDED'` status.
 */
export async function pauseSiblingForkAtBoundary<THandle = unknown>(
  batchParams: ForkBatchExecutionParams<THandle>,
  siblingEntry: ForkBatchEntryRecord,
  triggerWithHandle: PauseSiblingBarrierContext<THandle>,
): Promise<ForkBatchEntryRecord> {
  for (const frame of siblingEntry.continuationStack) {
    if (frame.kind === 'agent-frame' && frame.pauseState.kind === 'adjudication' && frame.pauseState.pendingAdjudication.humanRequestId !== undefined) {
      const reqId = frame.pauseState.pendingAdjudication.humanRequestId;
      for (const adapter of batchParams.humanAdaptersById?.values() ?? []) await adapter.cancelDecision?.(batchParams.ctx.runId, reqId);
    }
  }
  const ckpt = await batchParams.branchableScope.serializeCheckpoint(triggerWithHandle.siblingHandle);
  const nextEpoch = siblingEntry.suspensionEpoch + 1, suspendedForkId = `${siblingEntry.forkId}#${String(nextEpoch)}`;
  await batchParams.ledgerStore.recordForkSuspension(Object.freeze<SuspendedForkRecord>({
    suspendedForkId, forkId: siblingEntry.forkId, suspensionEpoch: nextEpoch, runId: batchParams.ctx.runId,
    parentStepExecId: batchParams.ctx.stepExecId, forkToolName: siblingEntry.toolName, activePartitions: siblingEntry.activePartitions,
    suspensionReason: 'PAUSED_BY_SIBLING_INTERRUPT', triggeredByForkId: triggerWithHandle.triggeredByForkId,
    conflictRetryCount: siblingEntry.conflictRetryCount, conflictCheckArmed: siblingEntry.conflictCheckArmed,
    childScopeCheckpoint: ckpt, continuationStack: siblingEntry.continuationStack,
  }));
  const summary = JSON.stringify({ status: 'PAUSED_BY_SIBLING_INTERRUPT', suspendedForkId, forkId: siblingEntry.forkId, triggeredByForkId: triggerWithHandle.triggeredByForkId });
  return Object.freeze<ForkBatchEntryRecord>({ ...siblingEntry, suspendedForkId, status: 'SUSPENDED', suspensionEpoch: nextEpoch, childScopeCheckpoint: ckpt, toolResultJson: summary });
}

/**
 * Coordinates the turn-batch sibling interrupt barrier when a child fork raises an upward interrupt (`SPEC.md` §3.7.2).
 *
 * Persists the raising fork's `SuspendedForkRecord`, pauses overlapping running siblings via `pauseSiblingForkAtBoundary`,
 * and records `alreadyCommittedSiblingForks` in the returned `ForkBatchEntryRecord.toolResultJson`.
 *
 * @template THandle Runtime handle type of the active `BranchableScope`.
 *
 * @param {ForkBatchExecutionParams<THandle>} batchParams  - Enclosing fork batch execution parameters.
 * @param {ForkBatchEntryRecord}              raisingEntry - Fork entry that raised the upward interrupt.
 * @param {TurnBatchBarrierContext<THandle>}  outcomeCtx   - Raising outcome and sibling handles.
 *
 * @returns {Promise<TurnBatchBarrierResult>} Settled barrier state.
 */
export async function coordinateTurnBatchInterruptBarrier<THandle = unknown>(
  batchParams: ForkBatchExecutionParams<THandle>,
  raisingEntry: ForkBatchEntryRecord,
  outcomeCtx: TurnBatchBarrierContext<THandle>,
): Promise<TurnBatchBarrierResult> {
  const interruptId = outcomeCtx.interruptId ?? 'unknown';
  const handler = batchParams.parentNode.onChildInterruptHandlers.find((h) => h.interrupt.id === interruptId);
  const affected = handler?.pauseSiblingForksInPartitions !== undefined ? handler.pauseSiblingForksInPartitions(outcomeCtx.interruptPayload) : raisingEntry.activePartitions;
  const nextEpoch = raisingEntry.suspensionEpoch + 1, suspendedForkId = `${raisingEntry.forkId}#${String(nextEpoch)}`;
  const ckpt = await batchParams.branchableScope.serializeCheckpoint(outcomeCtx.childHandle);
  const rolledStack = normalizeEvaluatorRollbackStack(outcomeCtx.continuationStack, outcomeCtx.raisedByPhase);
  const payloadJson = JSON.stringify(outcomeCtx.interruptPayload ?? null);
  await batchParams.ledgerStore.recordForkSuspension(Object.freeze<SuspendedForkRecord>({ suspendedForkId, forkId: raisingEntry.forkId, suspensionEpoch: nextEpoch, runId: batchParams.ctx.runId, parentStepExecId: batchParams.ctx.stepExecId, forkToolName: raisingEntry.toolName, activePartitions: raisingEntry.activePartitions, suspensionReason: 'INTERRUPT_RAISED', raisedByPhase: outcomeCtx.raisedByPhase, conflictRetryCount: raisingEntry.conflictRetryCount, conflictCheckArmed: raisingEntry.conflictCheckArmed, interruptId, interruptPayloadJson: payloadJson, suspendedAtCallId: outcomeCtx.suspendedAtCallId, childScopeCheckpoint: ckpt, continuationStack: rolledStack }));
  const trigger: PendingPauseTriggerRecord = Object.freeze({ triggeredByForkId: suspendedForkId, interruptId, interruptPayloadJson: payloadJson, affectedPartitions: Object.freeze([...affected]) });
  const alreadyCommittedSiblingForks: string[] = [], pausedSiblings: ForkBatchEntryRecord[] = [];
  for (const sib of outcomeCtx.siblingEntries) {
    if (sib.forkId === raisingEntry.forkId || !sib.activePartitions.some((p) => affected.includes(p))) continue;
    if (sib.status === 'CHILD_COMMITTED' || sib.status === 'COMPLETED') alreadyCommittedSiblingForks.push(sib.forkId);
    else if (sib.status === 'RUNNING') {
      const sibHandle = outcomeCtx.handlesByForkId.get(sib.forkId);
      if (sibHandle !== undefined) pausedSiblings.push(await pauseSiblingForkAtBoundary(batchParams, sib, { ...trigger, siblingHandle: sibHandle }));
    }
  }
  const resultJson = JSON.stringify({ status: 'SUSPENDED_ON_INTERRUPT', suspendedForkId, forkId: raisingEntry.forkId, interruptId, payload: outcomeCtx.interruptPayload, alreadyCommittedSiblingForks, pausedSiblingForkIds: pausedSiblings.map((p) => p.suspendedForkId) });
  return Object.freeze({ updatedRaisingEntry: Object.freeze<ForkBatchEntryRecord>({ ...raisingEntry, suspendedForkId, status: 'SUSPENDED', suspensionEpoch: nextEpoch, childScopeCheckpoint: ckpt, toolResultJson: resultJson, continuationStack: rolledStack }), trigger, pausedSiblings: Object.freeze(pausedSiblings) });
}

/**
 * Reconciles a completed child fork into `parentHandle` via `commitChild` with up to 2 conflict-bounce retries (`SPEC.md` §3.7.2).
 *
 * Persists `status: 'CHILD_COMMITTED'` before flushing `LessonStore.recordOutcomes()`, and on conflict
 * attaches `scope.getConflictLease(childHandle)`, arms `conflictCheckArmed`, rolls `loop-frame` back to `phase: 'act'`,
 * and appends `[COMMIT_CONFLICT]`.
 *
 * @template THandle Runtime handle type of the active `BranchableScope`.
 *
 * @param {ReconcileChildForkParams<THandle>} params - Child reconciliation and conflict-bounce parameters.
 *
 * @returns {Promise<ForkBatchEntryRecord>} Settled `ForkBatchEntryRecord` (`'COMPLETED'` or `'FAILED'`).
 */
export async function reconcileChildForkWithBounce<THandle = unknown>(
  params: ReconcileChildForkParams<THandle>,
): Promise<ForkBatchEntryRecord> {
  const { batchParams } = params;
  let currentEntry = params.entry, currentOutcome = params.outcome;
  while (currentEntry.status !== 'CHILD_COMMITTED') {
    const commitRes = await batchParams.lockManager.withWriteLock(batchParams.ctx.scopeHandle, () => batchParams.branchableScope.commitChild(params.childHandle, batchParams.ctx.scopeHandle));
    if (commitRes.status === 'clean') {
      currentEntry = Object.freeze<ForkBatchEntryRecord>({ ...currentEntry, status: 'CHILD_COMMITTED', outputJson: JSON.stringify(currentOutcome.output ?? null), committedReceiptJson: JSON.stringify(commitRes.data) });
      await params.persistEntryUpdate(currentEntry);
      break;
    }
    if (currentEntry.conflictRetryCount >= 2) {
      const failed = Object.freeze<ForkBatchEntryRecord>({ ...currentEntry, status: 'FAILED', toolResultJson: JSON.stringify({ status: 'COMMIT_CONFLICT_EXHAUSTED', forkId: currentEntry.forkId, conflictedSummary: commitRes.conflictedSummary }) });
      await params.persistEntryUpdate(failed);
      return failed;
    }
    const conflictLease = batchParams.branchableScope.getConflictLease?.(params.childHandle);
    const note = `[COMMIT_CONFLICT] ${commitRes.conflictedSummary}`, bounceFrameId = `msg:${currentEntry.forkId}:conflict:${String(currentEntry.conflictRetryCount + 1)}`;
    await batchParams.ledgerStore.appendMessageFrame(batchParams.ctx.runId, Object.freeze<WireFrameRecord>({ messageId: bounceFrameId, parentMessageId: currentOutcome.leafMessageId ?? null, vendorId: batchParams.modelDriver?.vendorId ?? 'anthropic', rawWireFrame: new TextEncoder().encode(note), canonical: Object.freeze({ role: 'user', visibleText: note }), prefixDigest: batchParams.wirePrefix?.systemDigest ?? 'unpinned' }));
    const bouncedStack = normalizeEvaluatorRollbackStack(currentOutcome.continuationStack, 'evaluate').map((f) => f.kind === 'agent-frame' ? Object.freeze<AgentContinuationFrame>({ ...f, leafMessageId: bounceFrameId, conflictCheckArmed: true, activeLeases: conflictLease !== undefined ? Object.freeze([...f.activeLeases, conflictLease]) : f.activeLeases }) : f.kind === 'loop-frame' ? Object.freeze<LoopContinuationFrame>({ ...f, conflictCheckArmed: true, grantedLoopLeases: conflictLease !== undefined ? Object.freeze([...f.grantedLoopLeases, conflictLease]) : f.grantedLoopLeases }) : f);
    currentEntry = Object.freeze<ForkBatchEntryRecord>({ ...currentEntry, conflictRetryCount: currentEntry.conflictRetryCount + 1, conflictCheckArmed: true, continuationStack: Object.freeze(bouncedStack) });
    await params.persistEntryUpdate(currentEntry);
    currentOutcome = await batchParams.executeChildStep(params.childNode, params.childInput, Object.freeze({ ...batchParams.ctx, scopeHandle: params.childHandle, activePartitions: currentEntry.activePartitions, activeLeases: conflictLease !== undefined ? Object.freeze([...batchParams.ctx.activeLeases, conflictLease]) : batchParams.ctx.activeLeases, resumeContinuationStack: currentEntry.continuationStack }));
  }
  if (currentEntry.lessonsFlushed !== true && batchParams.lessonStore !== undefined && currentOutcome.accumulatedLessonOutcomes !== undefined) {
    const pairs = Object.entries(currentOutcome.accumulatedLessonOutcomes).map(([lessonId, outcome]) => ({ lessonId, outcome }));
    if (pairs.length > 0) await batchParams.lessonStore.recordOutcomes(pairs);
  }
  const completed = Object.freeze<ForkBatchEntryRecord>({ ...currentEntry, status: 'COMPLETED', lessonsFlushed: true, toolResultJson: JSON.stringify({ status: 'COMPLETED', forkId: currentEntry.forkId, output: JSON.parse(currentEntry.outputJson ?? 'null'), scopeReceipt: JSON.parse(currentEntry.committedReceiptJson ?? '{}') }) });
  await params.persistEntryUpdate(completed);
  return completed;
}
