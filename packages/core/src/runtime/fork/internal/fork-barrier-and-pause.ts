import type { AgentContinuationFrame } from '../../../ports/agent-continuation-frame.js';
import type { ContinuationFrame } from '../../../ports/continuation-frame.types.js';
import type {
  ForkBatchEntryRecord,
  PendingPauseTriggerRecord,
} from '../../../ports/fork-batch-continuation-frame.js';
import type { LeaseDelta } from '../../../ports/lease-delta.js';
import type { LoopContinuationFrame } from '../../../ports/loop-continuation-frame.js';
import type { SuspendedForkRecord } from '../../../ports/suspended-fork-record.js';
import type { WireFrameRecord } from '../../../ports/wire-frame-record.js';
import type { ForkBatchExecutionParams } from '../fork-batch-execution-params.js';
import type { PauseSiblingBarrierContext } from '../pause-sibling-barrier-context.js';
import type { ReconcileChildForkParams } from '../reconcile-child-fork-params.js';
import type { TurnBatchBarrierContext } from '../turn-batch-barrier-context.js';
import type { TurnBatchBarrierResult } from '../turn-batch-barrier-result.js';
import { executeDefaultForkOrTournamentChild } from './run-single-fork-call.js';

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
  if (raisedPhase !== 'evaluate') {
    return stack;
  }
  const out: ContinuationFrame[] = [];
  for (const frame of stack) {
    if (frame.kind === 'loop-frame') {
      out.push(Object.freeze<LoopContinuationFrame>({ ...frame, phase: 'act' }));
      continue;
    }
    if (frame.kind !== 'agent-frame') {
      out.push(frame);
      continue;
    }
    const parentLoop = out.find((f): f is LoopContinuationFrame => f.kind === 'loop-frame');
    const hasActFrame =
      parentLoop !== undefined &&
      stack.some((f) => f.kind === 'agent-frame' && f.agentId === parentLoop.roleKey);
    if (parentLoop !== undefined && frame.agentId !== parentLoop.roleKey && hasActFrame) {
      continue;
    }
    if (frame.pauseState.kind === 'adjudication' || frame.pauseState.kind === 'tool-batch') {
      out.push(frame);
      continue;
    }
    out.push(
      Object.freeze<AgentContinuationFrame>({
        ...frame,
        agentId: parentLoop !== undefined ? parentLoop.roleKey : frame.agentId,
        roleKey: parentLoop !== undefined ? parentLoop.roleKey : frame.roleKey,
        leafMessageId: parentLoop?.preservedActLeafMessageId ?? frame.leafMessageId,
        pausedAtPhase: 'BEFORE_STOP_GATE',
        pauseState: Object.freeze({ kind: 'before-stop-gate' }),
      }),
    );
  }
  return Object.freeze(out);
}

/**
 * Normalizes a single `AgentContinuationFrame` when a sibling fork is paused at a turn-batch barrier.
 *
 * Cancels any pending `humanRequestId` decision and synthesizes tool pause results for remaining calls.
 *
 * @template THandle Runtime handle type of the active `BranchableScope`.
 *
 * @param {ForkBatchExecutionParams<THandle>} batchParams  - Enclosing fork batch execution parameters.
 * @param {ForkBatchEntryRecord}              siblingEntry - Sibling fork entry being paused.
 * @param {object}                            frameCtx     - Agent continuation frame and next suspension epoch.
 *
 * @returns {Promise<AgentContinuationFrame>} Normalized `AgentContinuationFrame` for suspension.
 */
async function normalizeSiblingAgentFrameForPause<THandle = unknown>(
  batchParams: ForkBatchExecutionParams<THandle>,
  siblingEntry: ForkBatchEntryRecord,
  frameCtx: { readonly frame: AgentContinuationFrame; readonly nextEpoch: number },
): Promise<AgentContinuationFrame> {
  const { frame, nextEpoch } = frameCtx;
  const isEscalated = frame.pauseState.kind === 'adjudication';
  const reqId = isEscalated ? frame.pauseState.pendingAdjudication.humanRequestId : undefined;
  if (reqId !== undefined) {
    for (const adapter of batchParams.humanAdaptersById?.values() ?? []) {
      await adapter.cancelDecision?.(batchParams.ctx.runId, reqId);
    }
  }
  const batch =
    frame.pauseState.kind === 'adjudication' || frame.pauseState.kind === 'tool-batch'
      ? frame.pauseState.pendingToolBatch
      : undefined;
  if (
    batch === undefined ||
    (batch.remainingCalls.length === 0 && batch.completedResults.length === 0)
  ) {
    return isEscalated
      ? Object.freeze<AgentContinuationFrame>({
          ...frame,
          pausedAtPhase: 'TOOL_BOUNDARY',
          pauseState: Object.freeze({ kind: 'active-turn' }),
        })
      : frame;
  }
  const pauseMsg = isEscalated
    ? '[Paused by sibling interrupt — pending escalation cancelled; re-evaluate after topology sync]'
    : '[Paused by sibling interrupt]';
  const toolResults: Array<{
    readonly callId: string;
    readonly content: string;
    readonly isError: boolean;
  }> = [];
  for (const cr of batch.completedResults) {
    toolResults.push(
      Object.freeze({ callId: cr.callId, content: cr.content, isError: Boolean(cr.isError) }),
    );
  }
  for (const rc of batch.remainingCalls) {
    toolResults.push(Object.freeze({ callId: rc.callId, content: pauseMsg, isError: true }));
  }
  const toolFrameId = `msg:${siblingEntry.forkId}:sibling-pause:${String(nextEpoch)}`;
  const frameJson = JSON.stringify(toolResults);
  await batchParams.ledgerStore.appendMessageFrame(
    batchParams.ctx.runId,
    Object.freeze<WireFrameRecord>({
      messageId: toolFrameId,
      parentMessageId: frame.leafMessageId,
      vendorId: batchParams.modelDriver?.vendorId ?? 'anthropic',
      rawWireFrame: new TextEncoder().encode(frameJson),
      canonical: Object.freeze({
        role: 'tool',
        visibleText: frameJson,
        toolResults: Object.freeze(toolResults),
      }),
      prefixDigest: batchParams.wirePrefix?.systemDigest ?? 'unpinned',
    }),
  );
  return Object.freeze<AgentContinuationFrame>({
    ...frame,
    leafMessageId: toolFrameId,
    pausedAtPhase: 'TOOL_BOUNDARY',
    pauseState: Object.freeze({ kind: 'active-turn' }),
  });
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
  const nextEpoch = siblingEntry.suspensionEpoch + 1;
  const suspendedForkId = `${siblingEntry.forkId}#${String(nextEpoch)}`;
  const isEvaluating = siblingEntry.continuationStack.some(
    (f) => f.kind === 'loop-frame' && f.phase === 'evaluate',
  );
  const baseStack = isEvaluating
    ? normalizeEvaluatorRollbackStack(siblingEntry.continuationStack, 'evaluate')
    : siblingEntry.continuationStack;
  const normalizedStack: ContinuationFrame[] = [];
  for (const frame of baseStack) {
    if (frame.kind !== 'agent-frame') {
      normalizedStack.push(frame);
      continue;
    }
    normalizedStack.push(
      await normalizeSiblingAgentFrameForPause(batchParams, siblingEntry, { frame, nextEpoch }),
    );
  }
  const frozenStack = Object.freeze(normalizedStack);
  const ckpt = await batchParams.branchableScope.serializeCheckpoint(
    triggerWithHandle.siblingHandle,
  );
  await batchParams.ledgerStore.recordForkSuspension(
    Object.freeze<SuspendedForkRecord>({
      suspendedForkId,
      forkId: siblingEntry.forkId,
      suspensionEpoch: nextEpoch,
      runId: batchParams.ctx.runId,
      parentStepExecId: batchParams.ctx.stepExecId,
      forkToolName: siblingEntry.toolName,
      activePartitions: siblingEntry.activePartitions,
      suspensionReason: 'PAUSED_BY_SIBLING_INTERRUPT',
      triggeredByForkId: triggerWithHandle.triggeredByForkId,
      conflictRetryCount: siblingEntry.conflictRetryCount,
      conflictCheckArmed: siblingEntry.conflictCheckArmed,
      childScopeCheckpoint: ckpt,
      continuationStack: frozenStack,
    }),
  );
  const summary = JSON.stringify({
    status: 'PAUSED_BY_SIBLING_INTERRUPT',
    suspendedForkId,
    forkId: siblingEntry.forkId,
    triggeredByForkId: triggerWithHandle.triggeredByForkId,
  });
  return Object.freeze<ForkBatchEntryRecord>({
    ...siblingEntry,
    suspendedForkId,
    status: 'SUSPENDED',
    suspensionEpoch: nextEpoch,
    childScopeCheckpoint: ckpt,
    continuationStack: frozenStack,
    toolResultJson: summary,
  });
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
  const handler = batchParams.parentNode.onChildInterruptHandlers.find(
    (h) => h.interrupt.id === interruptId,
  );
  const affected =
    handler?.pauseSiblingForksInPartitions !== undefined
      ? handler.pauseSiblingForksInPartitions(outcomeCtx.interruptPayload)
      : raisingEntry.activePartitions;
  const nextEpoch = raisingEntry.suspensionEpoch + 1;
  const suspendedForkId = `${raisingEntry.forkId}#${String(nextEpoch)}`;
  const ckpt = await batchParams.branchableScope.serializeCheckpoint(outcomeCtx.childHandle);
  const rolledStack = normalizeEvaluatorRollbackStack(
    outcomeCtx.continuationStack,
    outcomeCtx.raisedByPhase,
  );
  const payloadJson = JSON.stringify(outcomeCtx.interruptPayload ?? null);
  await batchParams.ledgerStore.recordForkSuspension(
    Object.freeze<SuspendedForkRecord>({
      suspendedForkId,
      forkId: raisingEntry.forkId,
      suspensionEpoch: nextEpoch,
      runId: batchParams.ctx.runId,
      parentStepExecId: batchParams.ctx.stepExecId,
      forkToolName: raisingEntry.toolName,
      activePartitions: raisingEntry.activePartitions,
      suspensionReason: 'INTERRUPT_RAISED',
      raisedByPhase: outcomeCtx.raisedByPhase,
      conflictRetryCount: raisingEntry.conflictRetryCount,
      conflictCheckArmed: raisingEntry.conflictCheckArmed,
      interruptId,
      interruptPayloadJson: payloadJson,
      suspendedAtCallId: outcomeCtx.suspendedAtCallId,
      childScopeCheckpoint: ckpt,
      continuationStack: rolledStack,
    }),
  );
  const trigger: PendingPauseTriggerRecord = Object.freeze({
    triggeredByForkId: suspendedForkId,
    interruptId,
    interruptPayloadJson: payloadJson,
    affectedPartitions: Object.freeze([...affected]),
  });
  const affectedSet = new Set(affected);
  const alreadyCommittedSiblingForks: string[] = [];
  const pausedSiblings: ForkBatchEntryRecord[] = [];
  for (const sib of outcomeCtx.siblingEntries) {
    if (
      sib.forkId === raisingEntry.forkId ||
      !sib.activePartitions.some((p) => affectedSet.has(p))
    ) {
      continue;
    }
    if (sib.status === 'CHILD_COMMITTED' || sib.status === 'COMPLETED') {
      alreadyCommittedSiblingForks.push(sib.forkId);
    } else if (sib.status === 'RUNNING') {
      const sibHandle = outcomeCtx.handlesByForkId.get(sib.forkId);
      if (sibHandle !== undefined) {
        pausedSiblings.push(
          await pauseSiblingForkAtBoundary(batchParams, sib, {
            ...trigger,
            siblingHandle: sibHandle,
          }),
        );
      }
    }
  }
  const resultJson = JSON.stringify({
    status: 'SUSPENDED_ON_INTERRUPT',
    suspendedForkId,
    forkId: raisingEntry.forkId,
    interruptId,
    payload: outcomeCtx.interruptPayload,
    alreadyCommittedSiblingForks,
    pausedSiblingForkIds: pausedSiblings.map((p) => p.suspendedForkId),
  });
  return Object.freeze({
    updatedRaisingEntry: Object.freeze<ForkBatchEntryRecord>({
      ...raisingEntry,
      suspendedForkId,
      status: 'SUSPENDED',
      suspensionEpoch: nextEpoch,
      childScopeCheckpoint: ckpt,
      toolResultJson: resultJson,
      continuationStack: rolledStack,
    }),
    trigger,
    pausedSiblings: Object.freeze(pausedSiblings),
  });
}

/**
 * Projects a conflict bounce message and optional `conflictLease` onto a rolled-back child continuation stack.
 *
 * Updates `leafMessageId`, `preservedActLeafMessageId`, `conflictCheckArmed`, and lease arrays.
 *
 * @param {readonly ContinuationFrame[]} stack         - Child continuation stack to roll back and update.
 * @param {string}                       bounceFrameId - Appended `[COMMIT_CONFLICT]` wire frame identifier.
 * @param {LeaseDelta | undefined}       conflictLease - Optional conflict lease attached by `BranchableScope`.
 *
 * @returns {readonly ContinuationFrame[]} Updated continuation stack for conflict-bounce retry.
 */
function buildConflictBouncedContinuationStack(
  stack: readonly ContinuationFrame[],
  bounceFrameId: string,
  conflictLease: LeaseDelta | undefined,
): readonly ContinuationFrame[] {
  const rolled = normalizeEvaluatorRollbackStack(stack, 'evaluate');
  const bounced: ContinuationFrame[] = [];
  for (const frame of rolled) {
    if (frame.kind === 'agent-frame') {
      bounced.push(
        Object.freeze<AgentContinuationFrame>({
          ...frame,
          leafMessageId: bounceFrameId,
          conflictCheckArmed: true,
          activeLeases:
            conflictLease !== undefined
              ? Object.freeze([...frame.activeLeases, conflictLease])
              : frame.activeLeases,
        }),
      );
    } else if (frame.kind === 'loop-frame') {
      bounced.push(
        Object.freeze<LoopContinuationFrame>({
          ...frame,
          preservedActLeafMessageId: bounceFrameId,
          conflictCheckArmed: true,
          grantedLoopLeases:
            conflictLease !== undefined
              ? Object.freeze([...frame.grantedLoopLeases, conflictLease])
              : frame.grantedLoopLeases,
        }),
      );
    } else {
      bounced.push(frame);
    }
  }
  return Object.freeze(bounced);
}

/**
 * Reconciles a completed child fork into `parentHandle` via `commitChild` with up to 2 conflict-bounce retries (`SPEC.md` §3.7.2).
 *
 * Persists `status: 'CHILD_COMMITTED'` before flushing `LessonStore.recordOutcomes()`, releases `childHandle`, and on conflict
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
  let currentEntry = params.entry;
  let currentOutcome = params.outcome;
  try {
    while (currentEntry.status !== 'CHILD_COMMITTED') {
      const commitRes = await batchParams.lockManager.withWriteLock(
        batchParams.ctx.scopeHandle,
        () => batchParams.branchableScope.commitChild(params.childHandle, batchParams.ctx.scopeHandle),
      );
      if (commitRes.status === 'clean') {
        currentEntry = Object.freeze<ForkBatchEntryRecord>({
          ...currentEntry,
          status: 'CHILD_COMMITTED',
          outputJson: JSON.stringify(currentOutcome.output ?? null),
          committedReceiptJson: JSON.stringify(commitRes.data),
        });
        await params.persistEntryUpdate(currentEntry);
        break;
      }
      if (currentEntry.conflictRetryCount >= 2) {
        const failed = Object.freeze<ForkBatchEntryRecord>({
          ...currentEntry,
          status: 'FAILED',
          toolResultJson: JSON.stringify({
            status: 'COMMIT_CONFLICT_EXHAUSTED',
            forkId: currentEntry.forkId,
            conflictedSummary: commitRes.conflictedSummary,
          }),
        });
        await params.persistEntryUpdate(failed);
        return failed;
      }
      const conflictLease = batchParams.branchableScope.getConflictLease?.(params.childHandle);
      const note = `[COMMIT_CONFLICT] ${commitRes.conflictedSummary}`;
      const bounceFrameId = `msg:${currentEntry.forkId}:conflict:${String(currentEntry.conflictRetryCount + 1)}`;
      await batchParams.ledgerStore.appendMessageFrame(
        batchParams.ctx.runId,
        Object.freeze<WireFrameRecord>({
          messageId: bounceFrameId,
          parentMessageId: currentOutcome.leafMessageId ?? null,
          vendorId: batchParams.modelDriver?.vendorId ?? 'anthropic',
          rawWireFrame: new TextEncoder().encode(note),
          canonical: Object.freeze({ role: 'user', visibleText: note }),
          prefixDigest: batchParams.wirePrefix?.systemDigest ?? 'unpinned',
        }),
      );
      const bouncedStack = buildConflictBouncedContinuationStack(
        currentOutcome.continuationStack,
        bounceFrameId,
        conflictLease,
      );
      currentEntry = Object.freeze<ForkBatchEntryRecord>({
        ...currentEntry,
        conflictRetryCount: currentEntry.conflictRetryCount + 1,
        conflictCheckArmed: true,
        continuationStack: bouncedStack,
      });
      await params.persistEntryUpdate(currentEntry);
      currentOutcome = await runStep(
        params.childNode,
        params.childInput,
        Object.freeze({
          ...batchParams.ctx,
          stepExecId: `${batchParams.ctx.stepExecId}:fork:${currentEntry.forkId}`,
          scopeHandle: params.childHandle,
          activePartitions: currentEntry.activePartitions,
          activeLeases:
            conflictLease !== undefined
              ? Object.freeze([...batchParams.ctx.activeLeases, conflictLease])
              : batchParams.ctx.activeLeases,
          resumeContinuationStack: currentEntry.continuationStack,
        }),
      );
    }
    if (
      currentEntry.lessonsFlushed !== true &&
      batchParams.lessonStore !== undefined &&
      currentOutcome.accumulatedLessonOutcomes !== undefined
    ) {
      const pairs = Object.entries(currentOutcome.accumulatedLessonOutcomes).map(
        ([lessonId, outcome]) => ({ lessonId, outcome }),
      );
      if (pairs.length > 0) {
        await batchParams.lessonStore.recordOutcomes(pairs);
      }
    }
    const completed = Object.freeze<ForkBatchEntryRecord>({
      ...currentEntry,
      status: 'COMPLETED',
      lessonsFlushed: true,
      toolResultJson: JSON.stringify({
        status: 'COMPLETED',
        forkId: currentEntry.forkId,
        output: JSON.parse(currentEntry.outputJson ?? 'null'),
        scopeReceipt: JSON.parse(currentEntry.committedReceiptJson ?? '{}'),
      }),
    });
    await params.persistEntryUpdate(completed);
    return completed;
  } finally {
    await batchParams.branchableScope.release(params.childHandle);
  }
}
