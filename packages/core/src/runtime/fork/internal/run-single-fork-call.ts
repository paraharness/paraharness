import type { AgentNode } from '../../../ast/agent-node.js';
import type { ModelASTNode, StepASTNode } from '../../../ast/domain-ast.types.js';
import type { LoopNode } from '../../../ast/loop-node.js';
import type { PoolNode } from '../../../ast/pool-node.js';
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
import { getStepRuntimeInternals } from '../../agent/internal/get-step-runtime-internals.js';
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
  const childOutcomeSink: {
    continuationStack?: readonly ContinuationFrame[];
    leafMessageId?: string | null;
    accumulatedLessonOutcomes?: Readonly<Record<string, LessonOutcome>>;
    raisedByPhase?: 'act' | 'evaluate';
    suspendedAtCallId?: string;
  } = {};
  const existingRuntime = getStepRuntimeInternals(env.childCtx) ?? {};
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
  for (const frame of forkedFrames) {
    await params.ledgerStore.appendMessageFrame(params.ctx.runId, frame);
  }
  if (call.capability.historyMode === 'clone-transcript' && forkedFrames.length > 0) {
    return forkedFrames;
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
