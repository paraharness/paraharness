import type { AgentNode } from '../../../ast/agent-node.js';
import type { ModelASTNode, StepASTNode } from '../../../ast/domain-ast.types.js';
import type { LoopNode } from '../../../ast/loop-node.js';
import type { PoolNode } from '../../../ast/pool-node.js';
import type { AgentContinuationFrame } from '../../../ports/agent-continuation-frame.js';
import type { ContinuationFrame } from '../../../ports/continuation-frame.types.js';
import type { ForkBatchEntryRecord } from '../../../ports/fork-batch-continuation-frame.js';
import type { HumanAdapter } from '../../../ports/human-adapter.js';
import type { LedgerStore } from '../../../ports/ledger-store.js';
import type { LessonOutcome } from '../../../ports/lesson-outcome.types.js';
import type { LessonStore } from '../../../ports/lesson-store.js';
import type { LoopContinuationFrame } from '../../../ports/loop-continuation-frame.js';
import type { StepExecutionContext } from '../../../ports/step-execution-context.js';
import type { SuspendedForkRecord } from '../../../ports/suspended-fork-record.js';
import type { WireFrameRecord } from '../../../ports/wire-frame-record.js';
import type { AgentTurnSessionState } from '../../agent/agent-turn-session-state.js';
import { executeAgent } from '../../agent/execute-agent.js';
import { getStepRuntimeInternals } from '../../agent/internal/get-step-runtime-internals.js';
import type { StepRuntimeChildOutcomeSink } from '../../agent/step-runtime-internals.js';
import type { ScopeLockManager } from '../../locks/scope-lock-manager.js';
import type { StepContinuationQueue } from '../../locks/step-continuation-queue.js';
import { executeLoop } from '../../loop/execute-loop.js';
import type { PoolManager } from '../../pools/pool-manager.js';
import { executeStepNode } from '../../step/execute-step-node.js';
import type { ChildForkExecutionOutcome } from '../child-fork-execution-outcome.js';
import type {
  ForkBatchExecutionParams,
  ForkDispatchCallItem,
} from '../fork-batch-execution-params.js';

/**
 * Incremental child turn, cost, and duration metrics rolled up into parent `outerFrames`.
 */
export interface RollUpChildMetricsDeltaParams {
  /** Number of additional model turns consumed by the child invocation. */
  readonly turnsTaken: number;
  /** Additional USD cost incurred by the child invocation. */
  readonly costUsd: number;
  /** Additional elapsed wall-clock milliseconds consumed by the child invocation. */
  readonly elapsedDurationMs: number;
}

/**
 * Adds incremental child execution metrics (`turnsTaken`, `costUsd`, `elapsedDurationMs`) into every `'agent-frame'` and `'loop-frame'` in `outerFrames`.
 *
 * Mutates `outerFrames` in place by replacing matching frame entries with frozen updated records.
 *
 * @param {readonly ContinuationFrame[] | undefined} outerFrames - Outer continuation frames array to update in place.
 * @param {RollUpChildMetricsDeltaParams}            delta       - Incremental turns, cost, and duration to roll up.
 */
export function rollUpChildMetricsIntoOuterFrames(
  outerFrames: readonly ContinuationFrame[] | undefined,
  delta: RollUpChildMetricsDeltaParams,
): void {
  if (
    outerFrames === undefined ||
    (delta.turnsTaken <= 0 && delta.costUsd <= 0 && delta.elapsedDurationMs <= 0)
  ) {
    return;
  }
  const mutableOuterFrames = outerFrames as ContinuationFrame[];
  for (let idx = 0; idx < mutableOuterFrames.length; idx += 1) {
    const outer = mutableOuterFrames[idx];
    if (outer?.kind === 'agent-frame') {
      mutableOuterFrames[idx] = Object.freeze<AgentContinuationFrame>({
        ...outer,
        turnsTaken: outer.turnsTaken + delta.turnsTaken,
        costUsd: outer.costUsd + delta.costUsd,
        elapsedDurationMs: outer.elapsedDurationMs + delta.elapsedDurationMs,
      });
    } else if (outer?.kind === 'loop-frame') {
      const isAct = outer.phase === 'act';
      mutableOuterFrames[idx] = Object.freeze<LoopContinuationFrame>({
        ...outer,
        actTurnsTaken: isAct ? outer.actTurnsTaken + delta.turnsTaken : outer.actTurnsTaken,
        actCostUsd: isAct ? outer.actCostUsd + delta.costUsd : outer.actCostUsd,
        actElapsedDurationMs: isAct
          ? outer.actElapsedDurationMs + delta.elapsedDurationMs
          : outer.actElapsedDurationMs,
        turnsTaken: outer.turnsTaken + delta.turnsTaken,
        costUsd: outer.costUsd + delta.costUsd,
        elapsedDurationMs: outer.elapsedDurationMs + delta.elapsedDurationMs,
      });
    }
  }
}

/**
 * Synchronizes a parent `AgentTurnSessionState`'s `outerFrames` and `agentFrame` after a child `.fork()`, `resumeFork()`, or `.speculate()` batch settles.
 *
 * @template TIn     Validated agent input payload type.
 * @template TOut    Validated agent output payload type.
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {AgentTurnSessionState<TIn, TOut, THandle>} session           - Parent agent turn session state.
 * @param {readonly ContinuationFrame[]}              sharedOuterFrames - Shared outer frames array passed to the child batch (`[...session.outerFrames, session.agentFrame]`).
 */
export function syncParentSessionFromOuterFrames<TIn, TOut, THandle>(
  session: AgentTurnSessionState<TIn, TOut, THandle>,
  sharedOuterFrames: readonly ContinuationFrame[],
): void {
  for (let idx = 0; idx < session.outerFrames.length; idx += 1) {
    const updatedOuter = sharedOuterFrames[idx];
    if (updatedOuter !== undefined) {
      session.outerFrames[idx] = updatedOuter;
    }
  }
  const updatedParentAgent = sharedOuterFrames[session.outerFrames.length];
  if (updatedParentAgent?.kind === 'agent-frame') {
    session.agentFrame = Object.freeze<AgentContinuationFrame>({
      ...session.agentFrame,
      turnsTaken: updatedParentAgent.turnsTaken,
      costUsd: updatedParentAgent.costUsd,
      elapsedDurationMs: updatedParentAgent.elapsedDurationMs,
    });
  }
}

/**
 * Wraps a child step runner so incremental child `turnsTaken`, `costUsd`, and `elapsedDurationMs` roll up into `outerFrames` in `finally`.
 *
 * @template THandle Runtime handle type of the active `BranchableScope`.
 *
 * @param {(childNode: StepASTNode<unknown, unknown, THandle>, childInput: unknown, childCtx: StepExecutionContext<THandle>) => Promise<ChildForkExecutionOutcome<unknown>>} baseRunner  - Underlying child step runner.
 * @param {readonly ContinuationFrame[]}                                                                                                                                      outerFrames - Enclosing outer continuation frames to update.
 *
 * @returns {(childNode: StepASTNode<unknown, unknown, THandle>, childInput: unknown, childCtx: StepExecutionContext<THandle>) => Promise<ChildForkExecutionOutcome<unknown>>} Wrapped child step runner.
 */
export function wrapChildStepRunnerWithOuterFrameRollup<THandle = unknown>(
  baseRunner: (
    childNode: StepASTNode<unknown, unknown, THandle>,
    childInput: unknown,
    childCtx: StepExecutionContext<THandle>,
  ) => Promise<ChildForkExecutionOutcome<unknown>>,
  outerFrames: readonly ContinuationFrame[],
): (
  childNode: StepASTNode<unknown, unknown, THandle>,
  childInput: unknown,
  childCtx: StepExecutionContext<THandle>,
) => Promise<ChildForkExecutionOutcome<unknown>> {
  return async (
    childNode: StepASTNode<unknown, unknown, THandle>,
    childInput: unknown,
    childCtx: StepExecutionContext<THandle>,
  ): Promise<ChildForkExecutionOutcome<unknown>> => {
    const existingRt = getStepRuntimeInternals(childCtx);
    const prevLoop = existingRt?.existingLoopFrame;
    const prevAgent = existingRt?.existingAgentFrame;
    const sink: StepRuntimeChildOutcomeSink = {};
    const ctxWithSink = Object.freeze({
      ...childCtx,
      _runtime: {
        ...(existingRt ?? {}),
        childOutcomeSink: sink,
      },
    }) as StepExecutionContext<THandle>;
    let settledOutcome: ChildForkExecutionOutcome<unknown> | undefined;
    try {
      settledOutcome = await baseRunner(childNode, childInput, ctxWithSink);
      return settledOutcome;
    } finally {
      const stack = settledOutcome?.continuationStack ?? sink.continuationStack;
      const nodeType = (childNode as { readonly type?: string }).type;
      if (nodeType === 'harness:loop') {
        let finalLoop: LoopContinuationFrame | undefined;
        if (stack !== undefined) {
          for (let idx = stack.length - 1; idx >= 0; idx -= 1) {
            const frame = stack[idx];
            if (frame?.kind === 'loop-frame') {
              finalLoop = frame;
              break;
            }
          }
        }
        if (finalLoop !== undefined) {
          rollUpChildMetricsIntoOuterFrames(outerFrames, {
            turnsTaken: Math.max(0, finalLoop.turnsTaken - (prevLoop?.turnsTaken ?? 0)),
            costUsd: Math.max(0, finalLoop.costUsd - (prevLoop?.costUsd ?? 0)),
            elapsedDurationMs: Math.max(
              0,
              finalLoop.elapsedDurationMs - (prevLoop?.elapsedDurationMs ?? 0),
            ),
          });
        }
      } else {
        let finalAgent: AgentContinuationFrame | undefined;
        if (stack !== undefined) {
          for (let idx = stack.length - 1; idx >= 0; idx -= 1) {
            const frame = stack[idx];
            if (frame?.kind === 'agent-frame') {
              finalAgent = frame;
              break;
            }
          }
        }
        if (finalAgent !== undefined) {
          rollUpChildMetricsIntoOuterFrames(outerFrames, {
            turnsTaken: Math.max(0, finalAgent.turnsTaken - (prevAgent?.turnsTaken ?? 0)),
            costUsd: Math.max(0, finalAgent.costUsd - (prevAgent?.costUsd ?? 0)),
            elapsedDurationMs: Math.max(
              0,
              finalAgent.elapsedDurationMs - (prevAgent?.elapsedDurationMs ?? 0),
            ),
          });
        }
      }
    }
  };
}

/**
 * Environment and shared runtime store parameters for `executeDefaultForkOrTournamentChild`.
 *
 * @template THandle Runtime handle type of the active `BranchableScope`.
 */
export interface ExecuteDefaultForkOrTournamentChildEnvParams<THandle = unknown> {
  /** Child step execution context. */
  readonly childCtx: StepExecutionContext<THandle>;
  /** Durable ledger store. */
  readonly ledgerStore: LedgerStore;
  /** Optional lesson store. */
  readonly lessonStore?: LessonStore;
  /** Per-scope read/write lock manager. */
  readonly lockManager: ScopeLockManager;
  /** Serialized continuation stack update queue. */
  readonly continuationQueue: StepContinuationQueue;
  /** Optional capacity pool manager. */
  readonly poolManager?: PoolManager;
  /** Optional registered human adapters keyed by channel ID. */
  readonly humanAdaptersById?: ReadonlyMap<string, HumanAdapter>;
  /** Optional outer continuation frames surrounding the child step. */
  readonly outerFrames?: readonly ContinuationFrame[];
}

/**
 * Default child step runner used by `executeForkBatch`, `executeResumeForkBatch`, and `executeSpeculateTournament` (`SPEC.md` §3.7.2).
 *
 * Dispatches `AgentNode`, `LoopNode`, or domain `StepASTNode` definitions via `executeAgent` / `executeLoop` / `executeStepNode`
 * and captures settled `continuationStack`, `leafMessageId`, `accumulatedLessonOutcomes`, and upward interrupts.
 *
 * @template THandle Runtime handle type of the active `BranchableScope`.
 *
 * @param {StepASTNode<unknown, unknown, THandle>}                   childNode - Child executable node.
 * @param {unknown}                                                  childIn   - Mapped child input payload.
 * @param {ExecuteDefaultForkOrTournamentChildEnvParams<THandle>}    env       - Child execution context and shared runtime stores.
 *
 * @returns {Promise<ChildForkExecutionOutcome<unknown>>} Settled child execution outcome.
 */
export async function executeDefaultForkOrTournamentChild<THandle = unknown>(
  childNode: StepASTNode<unknown, unknown, THandle>,
  childIn: unknown,
  env: ExecuteDefaultForkOrTournamentChildEnvParams<THandle>,
): Promise<ChildForkExecutionOutcome<unknown>> {
  const existingRuntime = getStepRuntimeInternals(env.childCtx) ?? {};
  const childOutcomeSink: StepRuntimeChildOutcomeSink = existingRuntime.childOutcomeSink ?? {};
  const enrichedCtx = Object.freeze({
    ...env.childCtx,
    _runtime: {
      ledgerStore: env.ledgerStore,
      lessonStore: env.lessonStore,
      lockManager: env.lockManager,
      continuationQueue: env.continuationQueue,
      poolManager: env.poolManager,
      humanAdaptersById: env.humanAdaptersById,
      outerFrames: env.outerFrames !== undefined ? [...env.outerFrames] : undefined,
      ...existingRuntime,
      childOutcomeSink,
    },
  });
  try {
    const nodeType = (childNode as { readonly type: string }).type;
    let output: unknown;
    if (nodeType === 'harness:agent') {
      output = await executeAgent(
        childNode as AgentNode<unknown, unknown, THandle>,
        childIn,
        enrichedCtx,
      );
    } else if (nodeType === 'harness:loop') {
      output = await executeLoop(
        childNode as LoopNode<unknown, unknown, THandle>,
        childIn,
        enrichedCtx,
      );
    } else {
      output = await executeStepNode(childNode, childIn, enrichedCtx);
    }
    return Object.freeze<ChildForkExecutionOutcome<unknown>>({
      status: 'completed',
      output,
      leafMessageId: childOutcomeSink.leafMessageId,
      accumulatedLessonOutcomes: childOutcomeSink.accumulatedLessonOutcomes,
      continuationStack: childOutcomeSink.continuationStack ?? Object.freeze([]),
    });
  } catch (err) {
    const intrErr = err as {
      readonly interruptResolution?: { readonly interruptId: string; readonly payload: unknown };
      readonly raisedByPhase?: 'act' | 'evaluate';
      readonly suspendedAtCallId?: string;
    };
    if (intrErr.interruptResolution !== undefined) {
      return Object.freeze<ChildForkExecutionOutcome<unknown>>({
        status: 'interrupt-raised',
        interruptId: intrErr.interruptResolution.interruptId,
        interruptPayload: intrErr.interruptResolution.payload,
        raisedByPhase: intrErr.raisedByPhase ?? childOutcomeSink.raisedByPhase ?? 'act',
        suspendedAtCallId: intrErr.suspendedAtCallId ?? childOutcomeSink.suspendedAtCallId,
        leafMessageId: childOutcomeSink.leafMessageId,
        accumulatedLessonOutcomes: childOutcomeSink.accumulatedLessonOutcomes,
        continuationStack: childOutcomeSink.continuationStack ?? Object.freeze([]),
      });
    }
    throw err;
  }
}

/**
 * Resolves a model identifier from a direct `ModelASTNode` or `PoolNode<ModelASTNode>`.
 *
 * Uses `poolManager.selectModel` when available or inspects the first pool item.
 *
 * @param {ModelASTNode | PoolNode<ModelASTNode>} rawModel    - Direct model node or model pool node.
 * @param {PoolManager | undefined}               poolManager - Optional capacity pool manager.
 * @param {string}                                runId       - Active flow run identifier.
 *
 * @returns {string} Resolved model identifier.
 */
function resolveForkModelId(
  rawModel: ModelASTNode | PoolNode<ModelASTNode>,
  poolManager: PoolManager | undefined,
  runId: string,
): string {
  if ('modelId' in rawModel) {
    return rawModel.modelId;
  }
  if (poolManager !== undefined) {
    return poolManager.selectModel(rawModel, runId, 0).modelId;
  }
  const firstItem = rawModel.items[0];
  if (firstItem !== undefined && 'modelId' in firstItem) {
    return firstItem.modelId;
  }
  return 'pool-model';
}

/**
 * Seeds a forked child transcript via `ModelDriver.prepareFork` when `parentLeafMessageId` is present (`SPEC.md` §3.7.2).
 *
 * Appends forked wire frames to `LedgerStore` and returns them when `historyMode === 'clone-transcript'`.
 *
 * @template THandle Runtime handle type of the active `BranchableScope`.
 *
 * @param {ForkBatchExecutionParams<THandle>} params - Enclosing fork batch execution parameters.
 * @param {ForkDispatchCallItem<THandle>}     call   - Single fork call item being prepared.
 *
 * @returns {Promise<readonly WireFrameRecord[] | undefined>} Cloned wire frames when `historyMode === 'clone-transcript'`.
 */
async function seedForkedChildTranscript<THandle = unknown>(
  params: ForkBatchExecutionParams<THandle>,
  call: ForkDispatchCallItem<THandle>,
): Promise<readonly WireFrameRecord[] | undefined> {
  if (
    params.modelDriver === undefined ||
    params.parentLeafMessageId === undefined ||
    params.parentLeafMessageId === null
  ) {
    return undefined;
  }
  const parentChain = await params.ledgerStore.getMessageChain(params.parentLeafMessageId);
  const rawChildModel =
    call.capability.childExecutable.type === 'harness:agent'
      ? call.capability.childExecutable.model
      : call.capability.childExecutable.actStep.actor.model;
  const childModelId = resolveForkModelId(rawChildModel, params.poolManager, params.ctx.runId);
  let outerAgentModelId: string | undefined;
  for (let i = params.outerFrames.length - 1; i >= 0; i -= 1) {
    const frame = params.outerFrames[i];
    if (frame?.kind === 'agent-frame') {
      outerAgentModelId = frame.modelId;
      break;
    }
  }
  const parentModelId =
    outerAgentModelId ??
    resolveForkModelId(params.parentNode.model, params.poolManager, params.ctx.runId);
  const forkedFrames = await params.modelDriver.prepareFork(
    {
      historyMode: call.capability.historyMode,
      parentChain,
      forkPointMessageId: params.parentLeafMessageId,
      precedingCompletedResults: params.precedingCompletedResults,
      siblingForkCallIds: params.siblingForkCallIds,
    },
    { modelId: childModelId, substituteTombstones: childModelId !== parentModelId },
  );
  const parentMessageIds = new Set<string>();
  for (const pf of parentChain) {
    parentMessageIds.add(pf.messageId);
  }
  const msgIdMap = new Map<string, string>();
  const persistedFrames: WireFrameRecord[] = [];
  for (let idx = 0; idx < forkedFrames.length; idx += 1) {
    const rawFrame = forkedFrames[idx] as WireFrameRecord;
    const oldFrame = parentChain[idx];
    const collidesWithParent = parentMessageIds.has(rawFrame.messageId);
    const collidesAcrossSiblingForks =
      (params.siblingForkCallIds?.length ?? 0) > 0 &&
      oldFrame !== undefined &&
      rawFrame.messageId === `${oldFrame.messageId}:fork`;
    const finalMsgId =
      collidesWithParent || collidesAcrossSiblingForks
        ? `${rawFrame.messageId}:fork:${call.callId}`
        : rawFrame.messageId;
    const remappedParentId =
      rawFrame.parentMessageId !== null
        ? (msgIdMap.get(rawFrame.parentMessageId) ?? rawFrame.parentMessageId)
        : null;
    if (oldFrame !== undefined) {
      msgIdMap.set(oldFrame.messageId, finalMsgId);
    }
    msgIdMap.set(rawFrame.messageId, finalMsgId);
    const frameToPersist =
      finalMsgId === rawFrame.messageId && remappedParentId === rawFrame.parentMessageId
        ? rawFrame
        : Object.freeze<WireFrameRecord>({
            ...rawFrame,
            messageId: finalMsgId,
            parentMessageId: remappedParentId,
          });
    await params.ledgerStore.appendMessageFrame(params.ctx.runId, frameToPersist);
    persistedFrames.push(frameToPersist);
  }
  if (call.capability.historyMode === 'clone-transcript' && persistedFrames.length > 0) {
    return Object.freeze(persistedFrames);
  }
  return undefined;
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
): Promise<{
  readonly call: ForkDispatchCallItem<THandle>;
  readonly childInput: unknown;
  readonly entry: ForkBatchEntryRecord;
  readonly childHandle: THandle;
  readonly childCtx: StepExecutionContext<THandle>;
}> {
  const parsedArgs = call.capability.requestSchema.parse(JSON.parse(call.argsJson || '{}'));
  const childInput = call.capability.mapInput(params.parentInput, parsedArgs);
  const partitions =
    call.capability.childExecutable.extractPartitions !== undefined
      ? call.capability.childExecutable.extractPartitions(childInput)
      : params.ctx.activePartitions;
  const entry =
    entriesByForkId.get(call.forkId) ??
    Object.freeze<ForkBatchEntryRecord>({
      forkId: call.forkId,
      callId: call.callId,
      toolName: call.capability.toolName,
      activePartitions: Object.freeze([...partitions]),
      status: 'RUNNING',
      conflictRetryCount: 0,
      conflictCheckArmed: false,
      suspensionEpoch: 0,
      continuationStack: Object.freeze([]),
    });
  const seededHistory = await seedForkedChildTranscript(params, call);
  const childHandle = await params.lockManager.withReadLock(
    params.ctx.scopeHandle,
    () => params.branchableScope.forkChild(params.ctx.scopeHandle, call.forkId),
    params.ctx.signal,
  );
  const initLease = params.branchableScope.getConflictLease?.(childHandle);
  const childCtx: StepExecutionContext<THandle> = Object.freeze({
    ...params.ctx,
    stepExecId: `${params.ctx.stepExecId}:fork:${call.forkId}`,
    scopeHandle: childHandle,
    activePartitions: entry.activePartitions,
    activeLeases:
      initLease !== undefined
        ? Object.freeze([...params.ctx.activeLeases, initLease])
        : params.ctx.activeLeases,
    seededHistory,
    resumeContinuationStack:
      entry.continuationStack.length > 0 ? entry.continuationStack : undefined,
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
): Promise<{
  readonly suspendedForkId: string;
  readonly forkId: string;
  readonly status: 'ABORTED';
}> {
  const childHandle = await params.lockManager.withReadLock(
    params.ctx.scopeHandle,
    () =>
      params.branchableScope.reattachChild(
        params.ctx.scopeHandle,
        record.forkId,
        record.childScopeCheckpoint,
      ),
    params.ctx.signal,
  );
  await params.branchableScope.release(childHandle);
  await params.ledgerStore.resolveSuspendedFork(record.suspendedForkId, 'ABORTED');
  const callId = params.resumeRequest?.callId ?? 'resumeFork';
  const summary = {
    suspendedForkId: record.suspendedForkId,
    forkId: record.forkId,
    status: 'ABORTED' as const,
  };
  const aborted = Object.freeze<ForkBatchEntryRecord>({
    forkId: record.forkId,
    suspendedForkId: record.suspendedForkId,
    callId,
    toolName: 'resumeFork',
    activePartitions: record.activePartitions,
    status: 'ABORTED',
    conflictRetryCount: record.conflictRetryCount,
    conflictCheckArmed: record.conflictCheckArmed,
    suspensionEpoch: record.suspensionEpoch,
    continuationStack: record.continuationStack,
    toolResultJson: JSON.stringify(summary),
  });
  await persistEntryUpdate(aborted);
  return summary;
}
