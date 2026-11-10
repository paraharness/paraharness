import type { AgentNode } from '../../../ast/agent-node.js';
import type { SpeculateCapabilityNode } from '../../../ast/speculate-capability-node.js';
import type { AgentContinuationFrame } from '../../../ports/agent-continuation-frame.js';
import type { BranchableScope } from '../../../ports/branchable-scope.js';
import type { ContinuationFrame } from '../../../ports/continuation-frame.types.js';
import type { PendingToolBatch, RemainingToolCallRecord } from '../../../ports/pending-tool-batch.js';
import type { RuntimeDriverContext } from '../../../ports/runtime-driver-context.js';
import { executeResumeForkBatch } from '../../fork/execute-fork-batch.js';
import { syncParentSessionFromOuterFrames } from '../../fork/internal/run-single-fork-call.js';
import {
  executeAddDependencies,
  executeSpawnTasks,
  executeUpdatePartitionContract,
} from '../../plan/execute-plan-mutation.js';
import type { SpawnTaskInputEntry } from '../../plan/plan-mutation-params.js';
import { executeSpeculateTournament } from '../../speculate/execute-speculate-tournament.js';
import type { AgentTurnSessionState } from '../agent-turn-session-state.js';
import type { InterruptEdgeResolution } from '../interrupt-edge-resolution.js';
import { getStepRuntimeInternals } from './get-step-runtime-internals.js';
import { handleSkillLifecycleToolCall } from './handle-skill-lifecycle-tool-call.js';
import { resolveInterruptEdge } from './resolve-interrupt-edge.js';

/**
 * Context parameters for `handleMutatePlanToolCall`.
 *
 * @template THandle Runtime handle type of the active isolation scope.
 */
export interface HandleMutatePlanToolCallContextParams<THandle = unknown> {
  /** Parsed tool call arguments record. */
  readonly args: Readonly<Record<string, unknown>>;
  /** Enclosing `PendingToolBatch` state. */
  readonly batch: PendingToolBatch;
  /** Resolved `BranchableScope` driver instance. */
  readonly scopeDriver: BranchableScope<
    THandle,
    Record<string, unknown>,
    Record<string, unknown>
  >;
}

/**
 * Resolves the active `BranchableScope` driver for built-in capability tools (`resumeFork`, `speculate`, `mutatePlan`).
 *
 * @template TIn     Validated agent input payload type.
 * @template TOut    Validated agent output payload type.
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {AgentTurnSessionState<TIn, TOut, THandle>} session - Active agent turn session state.
 * @param {RuntimeDriverContext}                      drvCtx  - Runtime driver context.
 *
 * @returns {BranchableScope<THandle, Record<string, unknown>, Record<string, unknown>>} Resolved branchable scope driver.
 */
function resolveCapabilityBranchableScope<TIn, TOut, THandle>(
  session: AgentTurnSessionState<TIn, TOut, THandle>,
  drvCtx: RuntimeDriverContext,
): BranchableScope<THandle, Record<string, unknown>, Record<string, unknown>> {
  const rtScope = getStepRuntimeInternals(session.ctx)?.branchableScope;
  const scopeFactory =
    session.ctx.scopeNode !== undefined
      ? session.ctx.registry.scopes[session.ctx.scopeNode.type]
      : undefined;
  return (session.ctx.scope ??
    rtScope ??
    (scopeFactory !== undefined && session.ctx.scopeNode !== undefined
      ? scopeFactory(session.ctx.scopeNode as never, drvCtx)
      : undefined)) as BranchableScope<THandle, Record<string, unknown>, Record<string, unknown>>;
}

/**
 * Handles the built-in `resumeFork` capability tool call (`SPEC.md` §3.7.2).
 *
 * @template TIn     Validated agent input payload type.
 * @template TOut    Validated agent output payload type.
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {AgentTurnSessionState<TIn, TOut, THandle>}                              session     - Active agent turn session state.
 * @param {RemainingToolCallRecord}                                                call        - `resumeFork` tool call record.
 * @param {BranchableScope<THandle, Record<string, unknown>, Record<string, unknown>>} scopeDriver - Active branchable scope driver.
 *
 * @returns {Promise<{ readonly status: 'completed'; readonly content: string; readonly isError: boolean }>} `resumeFork` execution result.
 */
async function handleResumeForkToolCall<TIn, TOut, THandle>(
  session: AgentTurnSessionState<TIn, TOut, THandle>,
  call: RemainingToolCallRecord,
  scopeDriver: BranchableScope<THandle, Record<string, unknown>, Record<string, unknown>>,
): Promise<{ readonly status: 'completed'; readonly content: string; readonly isError: boolean }> {
  const args = JSON.parse(call.argsJson || '{}') as Record<string, unknown>;
  const sharedOuterFrames: ContinuationFrame[] = [...session.outerFrames, session.agentFrame];
  let fRes: Awaited<ReturnType<typeof executeResumeForkBatch<THandle>>>;
  try {
    fRes = await executeResumeForkBatch({
      parentNode: session.node as AgentNode<unknown, unknown, THandle>,
      parentInput: session.validatedInput,
      parentLeafMessageId: session.agentFrame.leafMessageId,
      outerFrames: sharedOuterFrames,
      resumeRequest: {
        callId: call.callId,
        suspendedForkIds: (args['suspendedForkIds'] as readonly string[] | undefined) ?? [],
        action: (args['action'] as 'resume' | 'abort' | undefined) ?? 'resume',
        resolutionSummary: String(args['resolutionSummary'] ?? ''),
      },
      branchableScope: scopeDriver,
      lockManager: session.lockManager,
      continuationQueue: session.continuationQueue,
      ledgerStore: session.ledgerStore as NonNullable<typeof session.ledgerStore>,
      lessonStore: session.lessonStore,
      poolManager: session.poolManager,
      modelDriver: session.modelDriver,
      wirePrefix: session.wirePrefix,
      humanAdaptersById: session.humanAdaptersById,
      ctx: session.ctx,
      executeChildStep: session.executeChildStep,
    });
  } finally {
    syncParentSessionFromOuterFrames(session, sharedOuterFrames);
  }
  if (fRes.batchFrame.forks.some((f) => f.conflictCheckArmed)) {
    session.agentFrame = Object.freeze<AgentContinuationFrame>({
      ...session.agentFrame,
      conflictCheckArmed: true,
    });
  }
  const outEntry = fRes.toolResultsByCallId.get(call.callId);
  return Object.freeze({
    status: 'completed',
    content: outEntry?.content ?? JSON.stringify(fRes.batchFrame),
    isError: outEntry?.isError ?? false,
  });
}

/**
 * Handles a `.speculate()` tournament capability tool call (`SPEC.md` §3.7.2 Capability 2).
 *
 * @template TIn     Validated agent input payload type.
 * @template TOut    Validated agent output payload type.
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {AgentTurnSessionState<TIn, TOut, THandle>}                                          session     - Active agent turn session state.
 * @param {RemainingToolCallRecord}                                                            call        - Speculate capability tool call record.
 * @param {{ readonly specCap: SpeculateCapabilityNode<TIn, unknown, unknown, unknown, THandle, unknown, unknown>; readonly scopeDriver: BranchableScope<THandle, Record<string, unknown>, Record<string, unknown>> }} specCtx - Matched speculate capability and branchable scope driver.
 *
 * @returns {Promise<{ readonly status: 'completed'; readonly content: string; readonly isError: boolean }>} Tournament execution result.
 */
async function handleSpeculateToolCall<TIn, TOut, THandle>(
  session: AgentTurnSessionState<TIn, TOut, THandle>,
  call: RemainingToolCallRecord,
  specCtx: {
    readonly specCap: SpeculateCapabilityNode<
      TIn,
      unknown,
      unknown,
      unknown,
      THandle,
      unknown,
      unknown
    >;
    readonly scopeDriver: BranchableScope<
      THandle,
      Record<string, unknown>,
      Record<string, unknown>
    >;
  },
): Promise<{ readonly status: 'completed'; readonly content: string; readonly isError: boolean }> {
  const sharedOuterFrames: ContinuationFrame[] = [...session.outerFrames, session.agentFrame];
  let sRes: Awaited<ReturnType<typeof executeSpeculateTournament<THandle>>>;
  try {
    sRes = await executeSpeculateTournament({
      parentNode: session.node as AgentNode<unknown, unknown, THandle>,
      parentInput: session.validatedInput,
      callId: call.callId,
      capability: specCapAsUnknown(specCtx.specCap),
      argsJson: call.argsJson,
      outerFrames: sharedOuterFrames,
      branchableScope: specCtx.scopeDriver,
      lockManager: session.lockManager,
      continuationQueue: session.continuationQueue,
      ledgerStore: session.ledgerStore as NonNullable<typeof session.ledgerStore>,
      lessonStore: session.lessonStore,
      modelDriver: session.modelDriver,
      wirePrefix: session.wirePrefix,
      humanAdaptersById: session.humanAdaptersById,
      ctx: session.ctx,
      executeChildStep: session.executeChildStep,
    });
  } finally {
    syncParentSessionFromOuterFrames(session, sharedOuterFrames);
  }
  if (sRes.tournamentFrame.conflictCheckArmed) {
    session.agentFrame = Object.freeze<AgentContinuationFrame>({
      ...session.agentFrame,
      conflictCheckArmed: true,
    });
  }
  return Object.freeze({
    status: 'completed',
    content: sRes.toolResultText,
    isError: sRes.isError,
  });
}

/**
 * Widens `SpeculateCapabilityNode<TIn, ...>` to `SpeculateCapabilityNode<unknown, ...>` for `executeSpeculateTournament`.
 *
 * @template TIn     Parent input payload type.
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {SpeculateCapabilityNode<TIn, unknown, unknown, unknown, THandle, unknown, unknown>} cap - Speculate capability node.
 *
 * @returns {SpeculateCapabilityNode<unknown, unknown, unknown, unknown, THandle, unknown, unknown>} Widened speculate capability node.
 */
function specCapAsUnknown<TIn, THandle>(
  cap: SpeculateCapabilityNode<TIn, unknown, unknown, unknown, THandle, unknown, unknown>,
): SpeculateCapabilityNode<unknown, unknown, unknown, unknown, THandle, unknown, unknown> {
  return cap as SpeculateCapabilityNode<
    unknown,
    unknown,
    unknown,
    unknown,
    THandle,
    unknown,
    unknown
  >;
}

/**
 * Handles `.mutatePlan()` tools (`spawnTasks`, `addDependencies`, and `updatePartitionContract`) (`SPEC.md` §3.7.2 Capability 3).
 *
 * @template TIn     Validated agent input payload type.
 * @template TOut    Validated agent output payload type.
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {AgentTurnSessionState<TIn, TOut, THandle>}      session - Active agent turn session state.
 * @param {RemainingToolCallRecord}                        call    - Plan mutation tool call record.
 * @param {HandleMutatePlanToolCallContextParams<THandle>} mutCtx  - Parsed arguments, pending batch, and scope driver.
 *
 * @returns {Promise<{ readonly status: 'completed' | 'suspended'; readonly content: string; readonly isError: boolean } | undefined>} Plan mutation outcome, or `undefined`.
 */
async function handleMutatePlanToolCall<TIn, TOut, THandle>(
  session: AgentTurnSessionState<TIn, TOut, THandle>,
  call: RemainingToolCallRecord,
  mutCtx: HandleMutatePlanToolCallContextParams<THandle>,
): Promise<
  | {
      readonly status: 'completed' | 'suspended';
      readonly content: string;
      readonly isError: boolean;
    }
  | undefined
> {
  const mutatePlanNode = session.node.capabilities?.mutatePlan;
  if (
    mutatePlanNode === undefined ||
    (call.toolName !== 'spawnTasks' &&
      call.toolName !== 'addDependencies' &&
      call.toolName !== 'updatePartitionContract')
  ) {
    return undefined;
  }
  const { args, batch, scopeDriver } = mutCtx;
  const pParams = {
    mutatePlanNode,
    laneId: session.laneId ?? 'default-lane',
    parentItemKey: session.itemKey ?? session.ctx.runId,
    previouslySpawnedCount: session.spawnedTasksCount,
    previousSpawnedTipKey: session.previousSpawnedTipKey,
    tasksToSpawn: (args['tasks'] as readonly SpawnTaskInputEntry[] | undefined) ?? [],
    dependencyKeysToAdd:
      (args['prerequisiteItemKeys'] as readonly string[] | undefined) ??
      (args['dependsOn'] as readonly string[] | undefined) ??
      [],
    contractUpdate:
      (args['partition'] ?? args['partitionId']) !== undefined
        ? {
            partitionId: String(args['partition'] ?? args['partitionId']),
            newContractText: String(
              args['updatedContractText'] ?? args['newContractText'] ?? '',
            ),
          }
        : undefined,
    agentFrame: session.agentFrame,
    outerFrames: session.outerFrames,
    pendingToolBatch: batch,
    ledgerStore: session.ledgerStore as NonNullable<typeof session.ledgerStore>,
    continuationQueue: session.continuationQueue,
    topologyStore: session.topologyStore,
    serviceRegistry: session.serviceRegistry,
    checkpointScope: scopeDriver,
    ctx: session.ctx,
  };
  if (call.toolName === 'spawnTasks') {
    const r = await executeSpawnTasks(pParams);
    session.spawnedTasksCount += r.prerequisiteItemKeys.length;
    session.previousSpawnedTipKey = r.latestTipItemKey;
    return Object.freeze({
      status: r.suspended ? 'suspended' : 'completed',
      content: r.toolResultText,
      isError: false,
    });
  }
  if (call.toolName === 'addDependencies') {
    const r = await executeAddDependencies(pParams);
    return Object.freeze({
      status: r.suspended ? 'suspended' : 'completed',
      content: r.toolResultText,
      isError: false,
    });
  }
  return Object.freeze({
    status: 'completed',
    content: JSON.stringify(await executeUpdatePartitionContract(pParams)),
    isError: false,
  });
}

/**
 * Handles voluntary interrupt and escalation tools (`.canRaise(...)` and `.escalate(...)`) (`SPEC.md` §3.5 & §3.7.2).
 *
 * Uses $O(1)$ pre-indexed `session.escalationsByInterruptId` and `session.canRaiseInterruptsById` maps (`Rule 4.2`).
 *
 * @template TIn     Validated agent input payload type.
 * @template TOut    Validated agent output payload type.
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {AgentTurnSessionState<TIn, TOut, THandle>} session - Active agent turn session state.
 * @param {RemainingToolCallRecord}                   call    - Tool call record being dispatched.
 * @param {Readonly<Record<string, unknown>>}         args    - Parsed tool call arguments.
 *
 * @returns {Promise<{ readonly status: 'completed' | 'interrupted'; readonly content: string; readonly isError: boolean; readonly interruptResolution?: InterruptEdgeResolution<THandle> } | undefined>} Voluntary interrupt outcome, or `undefined`.
 */
async function handleVoluntaryInterruptToolCall<TIn, TOut, THandle>(
  session: AgentTurnSessionState<TIn, TOut, THandle>,
  call: RemainingToolCallRecord,
  args: Readonly<Record<string, unknown>>,
): Promise<
  | {
      readonly status: 'completed' | 'interrupted';
      readonly content: string;
      readonly isError: boolean;
      readonly interruptResolution?: InterruptEdgeResolution<THandle>;
    }
  | undefined
> {
  const escCap = session.escalationsByInterruptId.get(call.toolName);
  const canRaiseIntr = session.canRaiseInterruptsById.get(call.toolName);
  if (escCap === undefined && canRaiseIntr === undefined && call.toolName !== 'escalate') {
    return undefined;
  }
  const intrId =
    escCap?.interrupt.id ??
    canRaiseIntr?.id ??
    String(args['interruptId'] ?? 'harness:escalate');
  const res = await resolveInterruptEdge(session, intrId, args['payload'] ?? args);
  if (res.status === 'resumed') {
    return Object.freeze({
      status: 'completed',
      content: res.feedback ?? 'Resumed',
      isError: false,
    });
  }
  return Object.freeze({
    status: 'interrupted',
    content: `[Interrupted: ${intrId}]`,
    isError: true,
    interruptResolution: res,
  });
}

/**
 * Handles built-in skill (`activateSkill`, `completeSkill`) and capability (`resumeFork`, `speculate`, `spawnTasks`, `addDependencies`, `updatePartitionContract`, `escalate`, and `.canRaise()`) tools (`SPEC.md` §3.4.2 & §3.7.2).
 *
 * Returns `undefined` when `call.toolName` is not a built-in skill, capability, or voluntary interrupt tool.
 *
 * @template TIn     Validated agent input payload type.
 * @template TOut    Validated agent output payload type.
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {AgentTurnSessionState<TIn, TOut, THandle>} session - Active agent turn session state.
 * @param {RemainingToolCallRecord}                   call    - Tool call record being dispatched.
 * @param {PendingToolBatch}                          batch   - Current `PendingToolBatch` state.
 *
 * @returns {Promise<{ readonly status: 'completed' | 'suspended' | 'interrupted'; readonly content: string; readonly isError: boolean; readonly interruptResolution?: InterruptEdgeResolution<THandle> } | undefined>} Capability execution outcome, or `undefined`.
 */
export async function handleBuiltInSkillAndCapabilityTools<TIn, TOut, THandle>(
  session: AgentTurnSessionState<TIn, TOut, THandle>,
  call: RemainingToolCallRecord,
  batch: PendingToolBatch,
): Promise<
  | {
      readonly status: 'completed' | 'suspended' | 'interrupted';
      readonly content: string;
      readonly isError: boolean;
      readonly interruptResolution?: InterruptEdgeResolution<THandle>;
    }
  | undefined
> {
  const drvCtx: RuntimeDriverContext = {
    registry: session.ctx.registry,
    resolveEnv: (v) => session.ctx.resolveEnv(v),
    getRunner: (n) => session.ctx.getRunner(n),
  };
  const skillOut = await handleSkillLifecycleToolCall(session, call, drvCtx);
  if (skillOut !== undefined) {
    return skillOut;
  }
  const scopeDriver = resolveCapabilityBranchableScope(session, drvCtx);
  if (call.toolName === 'resumeFork') {
    return handleResumeForkToolCall(session, call, scopeDriver);
  }
  const specCap = session.speculationsByToolName.get(call.toolName);
  if (specCap !== undefined) {
    return handleSpeculateToolCall(session, call, { specCap, scopeDriver });
  }
  const args = JSON.parse(call.argsJson || '{}') as Record<string, unknown>;
  const mutOut = await handleMutatePlanToolCall(session, call, { args, batch, scopeDriver });
  if (mutOut !== undefined) {
    return mutOut;
  }
  return handleVoluntaryInterruptToolCall(session, call, args);
}
