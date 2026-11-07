import type { AgentNode } from '../../../ast/agent-node.js';
import type { StepASTNode } from '../../../ast/domain-ast.types.js';
import type { LoopNode } from '../../../ast/loop-node.js';
import type { ContinuationFrame } from '../../../ports/continuation-frame.types.js';
import type { ForkBatchEntryRecord } from '../../../ports/fork-batch-continuation-frame.js';
import type { HumanAdapter } from '../../../ports/human-adapter.js';
import type { LedgerStore } from '../../../ports/ledger-store.js';
import type { LessonOutcome } from '../../../ports/lesson-outcome.types.js';
import type { LessonStore } from '../../../ports/lesson-store.js';
import type { StepExecutionContext } from '../../../ports/step-execution-context.js';
import type { SuspendedForkRecord } from '../../../ports/suspended-fork-record.js';
import type { WireFrameRecord } from '../../../ports/wire-frame-record.js';
import { executeAgent } from '../../agent/execute-agent.js';
import type { ScopeLockManager } from '../../locks/scope-lock-manager.js';
import type { StepContinuationQueue } from '../../locks/step-continuation-queue.js';
import { executeLoop } from '../../loop/execute-loop.js';
import type { PoolManager } from '../../pools/pool-manager.js';
import { executeStepNode } from '../../step/execute-step-node.js';
import type { ChildForkExecutionOutcome } from '../child-fork-execution-outcome.js';
import type { ForkBatchExecutionParams, ForkDispatchCallItem } from '../fork-batch-execution-params.js';

/**
 * Default child step runner used by `executeForkBatch`, `executeResumeForkBatch`, and `executeSpeculateTournament` (`SPEC.md` §3.7.2).
 *
 * Dispatches `AgentNode`, `LoopNode`, or domain `StepASTNode` definitions via `executeAgent` / `executeLoop` / `executeStepNode`
 * and captures settled `continuationStack`, `leafMessageId`, `accumulatedLessonOutcomes`, and upward interrupts.
 *
 * @template THandle Runtime handle type of the active `BranchableScope`.
 *
 * @param {StepASTNode<unknown, unknown, THandle>} childNode - Child executable node.
 * @param {unknown}                                childIn   - Mapped child input payload.
 * @param {object}                                 env       - Child execution context and shared runtime stores.
 *
 * @returns {Promise<ChildForkExecutionOutcome<unknown>>} Settled child execution outcome.
 */
export async function executeDefaultForkOrTournamentChild<THandle = unknown>(
  childNode: StepASTNode<unknown, unknown, THandle>,
  childIn: unknown,
  env: {
    readonly childCtx: StepExecutionContext<THandle>;
    readonly ledgerStore: LedgerStore;
    readonly lessonStore?: LessonStore;
    readonly lockManager: ScopeLockManager;
    readonly continuationQueue: StepContinuationQueue;
    readonly poolManager?: PoolManager;
    readonly humanAdaptersById?: ReadonlyMap<string, HumanAdapter>;
    readonly outerFrames?: readonly ContinuationFrame[];
  },
): Promise<ChildForkExecutionOutcome<unknown>> {
  const childOutcomeSink: { continuationStack?: readonly ContinuationFrame[]; leafMessageId?: string | null; accumulatedLessonOutcomes?: Readonly<Record<string, LessonOutcome>>; raisedByPhase?: 'act' | 'evaluate'; suspendedAtCallId?: string } = {};
  const existingRuntime = (env.childCtx as StepExecutionContext<THandle> & { readonly _runtime?: Record<string, unknown> })._runtime ?? {};
  const enrichedCtx = Object.freeze({ ...env.childCtx, _runtime: { ledgerStore: env.ledgerStore, lessonStore: env.lessonStore, lockManager: env.lockManager, continuationQueue: env.continuationQueue, poolManager: env.poolManager, humanAdaptersById: env.humanAdaptersById, outerFrames: env.outerFrames !== undefined ? [...env.outerFrames] : undefined, ...existingRuntime, childOutcomeSink } });
  try {
    const nodeType = (childNode as { readonly type: string }).type;
    const output = nodeType === 'harness:agent' ? await executeAgent(childNode as AgentNode<unknown, unknown, THandle>, childIn, enrichedCtx) : nodeType === 'harness:loop' ? await executeLoop(childNode as LoopNode<unknown, unknown, THandle>, childIn, enrichedCtx) : await executeStepNode(childNode, childIn, enrichedCtx);
    return Object.freeze<ChildForkExecutionOutcome<unknown>>({ status: 'completed', output, leafMessageId: childOutcomeSink.leafMessageId, accumulatedLessonOutcomes: childOutcomeSink.accumulatedLessonOutcomes, continuationStack: childOutcomeSink.continuationStack ?? Object.freeze([]) });
  } catch (err) {
    const intrErr = err as { readonly interruptResolution?: { readonly interruptId: string; readonly payload: unknown }; readonly raisedByPhase?: 'act' | 'evaluate'; readonly suspendedAtCallId?: string };
    if (intrErr.interruptResolution !== undefined) {
      return Object.freeze<ChildForkExecutionOutcome<unknown>>({ status: 'interrupt-raised', interruptId: intrErr.interruptResolution.interruptId, interruptPayload: intrErr.interruptResolution.payload, raisedByPhase: intrErr.raisedByPhase ?? childOutcomeSink.raisedByPhase ?? 'act', suspendedAtCallId: intrErr.suspendedAtCallId ?? childOutcomeSink.suspendedAtCallId, leafMessageId: childOutcomeSink.leafMessageId, accumulatedLessonOutcomes: childOutcomeSink.accumulatedLessonOutcomes, continuationStack: childOutcomeSink.continuationStack ?? Object.freeze([]) });
    }
    throw err;
  }
}

/**
 * Prepares the forked transcript via `ModelDriver.prepareFork` and forks the isolated `childHandle` under a shared read lock (`SPEC.md` §3.7.2).
 *
 * Forwards `precedingCompletedResults` and `siblingForkCallIds` into `ModelDriver.prepareFork`.
 *
 * @template THandle Runtime handle type of the active `BranchableScope`.
 *
 * @param {ForkBatchExecutionParams<THandle>}         params          - Enclosing fork batch execution parameters.
 * @param {ForkDispatchCallItem<THandle>}             call            - Single fork call item to prepare.
 * @param {ReadonlyMap<string, ForkBatchEntryRecord>} entriesByForkId - Existing fork entry records map.
 *
 * @returns {Promise<{ readonly call: ForkDispatchCallItem<THandle>; readonly childInput: unknown; readonly entry: ForkBatchEntryRecord; readonly childHandle: THandle; readonly childCtx: StepExecutionContext<THandle> }>} Prepared fork execution descriptor.
 */
export async function prepareForkCallContext<THandle = unknown>(
  params: ForkBatchExecutionParams<THandle>,
  call: ForkDispatchCallItem<THandle>,
  entriesByForkId: ReadonlyMap<string, ForkBatchEntryRecord>,
): Promise<{ readonly call: ForkDispatchCallItem<THandle>; readonly childInput: unknown; readonly entry: ForkBatchEntryRecord; readonly childHandle: THandle; readonly childCtx: StepExecutionContext<THandle> }> {
  const parsedArgs = call.capability.requestSchema.parse(JSON.parse(call.argsJson || '{}'));
  const childInput = call.capability.mapInput(params.parentInput, parsedArgs);
  const parts = call.capability.childExecutable.extractPartitions !== undefined ? call.capability.childExecutable.extractPartitions(childInput) : params.ctx.activePartitions;
  const entry = entriesByForkId.get(call.forkId) ?? Object.freeze<ForkBatchEntryRecord>({
    forkId: call.forkId, callId: call.callId, toolName: call.capability.toolName, activePartitions: Object.freeze([...parts]),
    status: 'RUNNING', conflictRetryCount: 0, conflictCheckArmed: false, suspensionEpoch: 0, continuationStack: Object.freeze([]),
  });
  let seededHistory: readonly WireFrameRecord[] | undefined;
  if (params.modelDriver !== undefined && params.parentLeafMessageId !== undefined && params.parentLeafMessageId !== null) {
    const parentChain = await params.ledgerStore.getMessageChain(params.parentLeafMessageId);
    const rawModel = call.capability.childExecutable.type === 'harness:agent' ? call.capability.childExecutable.model : call.capability.childExecutable.actStep.actor.model;
    const childModelId = 'modelId' in rawModel ? rawModel.modelId : (params.poolManager !== undefined ? params.poolManager.selectModel(rawModel, params.ctx.runId, 0).modelId : (rawModel.items[0] !== undefined && 'modelId' in rawModel.items[0] ? rawModel.items[0].modelId : 'pool-model'));
    const outerAgent = [...params.outerFrames].reverse().find((f) => f.kind === 'agent-frame');
    const parentModelId = outerAgent?.kind === 'agent-frame' ? outerAgent.modelId : ('modelId' in params.parentNode.model ? params.parentNode.model.modelId : (params.poolManager !== undefined ? params.poolManager.selectModel(params.parentNode.model, params.ctx.runId, 0).modelId : undefined));
    const forkedFrames = await params.modelDriver.prepareFork(
      { historyMode: call.capability.historyMode, parentChain, forkPointMessageId: params.parentLeafMessageId, precedingCompletedResults: params.precedingCompletedResults, siblingForkCallIds: params.siblingForkCallIds },
      { modelId: childModelId, substituteTombstones: childModelId !== parentModelId },
    );
    for (const ff of forkedFrames) await params.ledgerStore.appendMessageFrame(params.ctx.runId, ff);
    if (call.capability.historyMode === 'clone-transcript' && forkedFrames.length > 0) seededHistory = forkedFrames;
  }
  const childHandle = await params.lockManager.withReadLock(params.ctx.scopeHandle, () => params.branchableScope.forkChild(params.ctx.scopeHandle, call.forkId));
  const initLease = params.branchableScope.getConflictLease?.(childHandle);
  const childCtx: StepExecutionContext<THandle> = Object.freeze({
    ...params.ctx, stepExecId: `${params.ctx.stepExecId}:fork:${call.forkId}`, scopeHandle: childHandle, activePartitions: entry.activePartitions,
    activeLeases: initLease !== undefined ? Object.freeze([...params.ctx.activeLeases, initLease]) : params.ctx.activeLeases,
    seededHistory, resumeContinuationStack: entry.continuationStack.length > 0 ? entry.continuationStack : undefined,
  });
  return { call, childInput, entry, childHandle, childCtx };
}

/**
 * Aborts a suspended child fork, releases its child scope handle, and records `'ABORTED'` in `LedgerStore` (`SPEC.md` §3.7.2).
 *
 * Ensures no orphaned child worktree handle remains live after `resumeFork({ action: 'abort' })`.
 *
 * @template THandle Runtime handle type of the active `BranchableScope`.
 *
 * @param {ForkBatchExecutionParams<THandle>}                params             - Resume fork batch execution parameters.
 * @param {SuspendedForkRecord}                              record             - Suspended fork record being aborted.
 * @param {(updated: ForkBatchEntryRecord) => Promise<void>} persistEntryUpdate - Continuation stack persistence callback.
 *
 * @returns {Promise<{ readonly suspendedForkId: string; readonly forkId: string; readonly status: 'ABORTED' }>} Aborted fork summary.
 */
export async function abortSuspendedForkRecord<THandle = unknown>(
  params: ForkBatchExecutionParams<THandle>,
  record: SuspendedForkRecord,
  persistEntryUpdate: (updated: ForkBatchEntryRecord) => Promise<void>,
): Promise<{ readonly suspendedForkId: string; readonly forkId: string; readonly status: 'ABORTED' }> {
  const childHandle = await params.lockManager.withReadLock(params.ctx.scopeHandle, () =>
    params.branchableScope.reattachChild(params.ctx.scopeHandle, record.forkId, record.childScopeCheckpoint),
  );
  await params.branchableScope.release(childHandle);
  await params.ledgerStore.resolveSuspendedFork(record.suspendedForkId, 'ABORTED');
  const callId = params.resumeRequest?.callId ?? 'resumeFork';
  const summary = { suspendedForkId: record.suspendedForkId, forkId: record.forkId, status: 'ABORTED' as const };
  const aborted = Object.freeze<ForkBatchEntryRecord>({
    forkId: record.forkId, suspendedForkId: record.suspendedForkId, callId, toolName: 'resumeFork',
    activePartitions: record.activePartitions, status: 'ABORTED', conflictRetryCount: record.conflictRetryCount,
    conflictCheckArmed: record.conflictCheckArmed, suspensionEpoch: record.suspensionEpoch,
    continuationStack: record.continuationStack, toolResultJson: JSON.stringify(summary),
  });
  await persistEntryUpdate(aborted);
  return summary;
}
