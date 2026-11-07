import type { AgentContinuationFrame } from '../../../ports/agent-continuation-frame.js';
import type { ContinuationFrame } from '../../../ports/continuation-frame.types.js';
import type { IsolationScope } from '../../../ports/isolation-scope.js';
import type { LoopContinuationFrame } from '../../../ports/loop-continuation-frame.js';
import type { StepExecutionContext } from '../../../ports/step-execution-context.js';
import { executeAgent } from '../../agent/execute-agent.js';
import { getStepRuntimeInternals } from '../../agent/internal/get-step-runtime-internals.js';
import { mergeLessonOutcomePrecedence } from '../../lessons/lesson-scoring.js';
import type { LoopExecutionState } from '../loop-execution-state.js';
import { escalateLoopActorModelIfNeeded } from './escalate-loop-actor-model.js';

/**
 * Builds the resumed or preserved `AgentContinuationFrame` for the `.act()` actor turn (`SPEC.md` §3.8).
 *
 * Restores `preservedActLeafMessageId` when `preserveActorSession` is enabled and merges `grantedLoopLeases`.
 *
 * @template TIn     Validated loop input payload type.
 * @template TOut    Validated loop output payload type.
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {LoopExecutionState<TIn, TOut, THandle>} state - Active loop execution state.
 *
 * @returns {{ readonly existingAgentFrame: AgentContinuationFrame | undefined; readonly resumeLeaf: string | null }} Prepared continuation frame and leaf message ID.
 */
function buildLoopActContinuationFrame<TIn, TOut, THandle>(
  state: LoopExecutionState<TIn, TOut, THandle>,
): {
  readonly existingAgentFrame: AgentContinuationFrame | undefined;
  readonly resumeLeaf: string | null;
} {
  const actor = state.node.actStep.actor;
  const resumedInnerAgent =
    state.loopFrame.iteration === 0
      ? state.ctx.resumeContinuationStack?.find(
          (f): f is AgentContinuationFrame => f.kind === 'agent-frame' && f.agentId === actor.id,
        )
      : undefined;
  const resumeLeaf = state.node.preserveActorSession
    ? (state.loopFrame.preservedActLeafMessageId ?? resumedInnerAgent?.leafMessageId ?? null)
    : (resumedInnerAgent?.leafMessageId ?? null);
  if (resumedInnerAgent !== undefined) {
    return {
      resumeLeaf,
      existingAgentFrame: Object.freeze<AgentContinuationFrame>({
        ...resumedInnerAgent,
        activeLeases: Object.freeze([
          ...state.loopFrame.grantedLoopLeases,
          ...resumedInnerAgent.activeLeases,
        ]),
      }),
    };
  }
  if (resumeLeaf === null) {
    return { resumeLeaf: null, existingAgentFrame: undefined };
  }
  return {
    resumeLeaf,
    existingAgentFrame: Object.freeze<AgentContinuationFrame>({
      kind: 'agent-frame',
      agentId: actor.id,
      roleKey: actor.roleKey,
      modelId: state.currentActModelNode.modelId,
      stepExecId: state.ctx.stepExecId,
      inputJson: state.loopFrame.loopInputJson,
      leafMessageId: resumeLeaf,
      turnsTaken: state.loopFrame.actTurnsTaken,
      costUsd: state.loopFrame.actCostUsd,
      elapsedDurationMs: state.loopFrame.actElapsedDurationMs,
      activeLeases: state.loopFrame.grantedLoopLeases,
      activeSkillIds: state.loopFrame.activeSkillIds,
      activeSkillActivations: state.loopFrame.activeSkillActivations,
      observedEffects: state.loopFrame.observedEffects,
      injectedScopedRuleIds: state.loopFrame.injectedScopedRuleIds,
      pausedAtPhase: 'TOOL_BOUNDARY',
      pauseState: Object.freeze({ kind: 'active-turn' }),
      conflictCheckArmed: state.loopFrame.conflictCheckArmed,
      accumulatedLessonOutcomes: state.accumulatedLessonOutcomes,
    }),
  };
}

/**
 * Inspects the active isolation scope under a shared read lock to capture `lastActScopeReceiptJson` (`SPEC.md` §3.8).
 *
 * Returns `{}` when no scope driver is bound to the step execution context.
 *
 * @template TIn     Validated loop input payload type.
 * @template TOut    Validated loop output payload type.
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {LoopExecutionState<TIn, TOut, THandle>} state - Active loop execution state.
 *
 * @returns {Promise<unknown>} Scope inspection receipt.
 */
async function inspectLoopActScopeReceipt<TIn, TOut, THandle>(
  state: LoopExecutionState<TIn, TOut, THandle>,
): Promise<unknown> {
  const scopeFactory =
    state.ctx.scopeNode !== undefined
      ? state.ctx.registry.scopes[state.ctx.scopeNode.type]
      : undefined;
  const scopeDriver = (state.ctx.scope ??
    (scopeFactory !== undefined && state.ctx.scopeNode !== undefined
      ? scopeFactory(state.ctx.scopeNode as never, {
          registry: state.ctx.registry,
          resolveEnv: (v) => state.ctx.resolveEnv(v),
          getRunner: (n) => state.ctx.getRunner(n),
        })
      : undefined)) as IsolationScope<THandle> | undefined;
  if (scopeDriver === undefined) {
    return {};
  }
  return state.lockManager.withReadLock(
    state.ctx.scopeHandle,
    () => scopeDriver.inspect(state.ctx.scopeHandle),
    state.ctx.signal,
  );
}

/**
 * Executes the `.act()` phase of a loop iteration, quiesces `'skill'`-scoped services on exit, and snapshots `scopeReceipt` (`SPEC.md` §3.8).
 *
 * Transitions `loopFrame.phase` to `'evaluate'` and persists `preservedActLeafMessageId`, `lastActOutputJson`, and `lastActScopeReceiptJson`.
 *
 * @template TIn     Validated loop input payload type.
 * @template TOut    Validated loop output payload type.
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {LoopExecutionState<TIn, TOut, THandle>} state - Active loop execution state.
 *
 * @returns {Promise<TOut>} Validated `.act()` output produced by the actor.
 */
export async function runLoopActPhase<TIn, TOut, THandle>(
  state: LoopExecutionState<TIn, TOut, THandle>,
): Promise<TOut> {
  if (state.loopFrame.iteration > 0) {
    await escalateLoopActorModelIfNeeded(state);
  }
  const actor = state.node.actStep.actor;
  const { existingAgentFrame, resumeLeaf } = buildLoopActContinuationFrame(state);
  const outerForAct: ContinuationFrame[] = [...state.outerFrames, state.loopFrame];
  const actOutcomeSink: {
    continuationStack?: readonly ContinuationFrame[];
    suspendedAtCallId?: string;
  } = {};
  const parentRt = getStepRuntimeInternals(state.ctx);
  const actCtx = Object.freeze({
    ...state.ctx,
    resumeContinuationStack: undefined,
    _runtime: {
      ...parentRt,
      ledgerStore: state.ledgerStore,
      topologyStore: state.topologyStore,
      lessonStore: state.lessonStore,
      lockManager: state.lockManager,
      continuationQueue: state.continuationQueue,
      poolManager: state.poolManager,
      serviceRegistry: state.serviceRegistry,
      humanAdaptersById: state.humanAdaptersById,
      wirePrefixesByGroupId: state.wirePrefixesByGroupId,
      outerFrames: outerForAct,
      existingAgentFrame,
      overrideModelNode: state.currentActModelNode,
      childOutcomeSink: actOutcomeSink,
    },
  }) as StepExecutionContext<THandle>;
  let actOutput: TOut;
  try {
    actOutput = await executeAgent(actor, state.validatedInput, actCtx);
    state.lastInnerAgentFrame = undefined;
  } catch (err) {
    state.lastInnerAgentFrame = actOutcomeSink.continuationStack?.find(
      (f): f is AgentContinuationFrame => f.kind === 'agent-frame',
    );
    throw err;
  } finally {
    state.lastSuspendedAtCallId = actOutcomeSink.suspendedAtCallId;
    const latestLoop = outerForAct[outerForAct.length - 1];
    if (latestLoop?.kind === 'loop-frame') {
      state.loopFrame = latestLoop;
    }
  }
  const updatedLoop = outerForAct[outerForAct.length - 1] as LoopContinuationFrame;
  for (const lid in updatedLoop.accumulatedLessonOutcomes) {
    if (!Object.hasOwn(updatedLoop.accumulatedLessonOutcomes, lid)) {
      continue;
    }
    const lo = updatedLoop.accumulatedLessonOutcomes[lid];
    if (lo !== undefined) {
      state.accumulatedLessonOutcomes[lid] = mergeLessonOutcomePrecedence(
        state.accumulatedLessonOutcomes[lid],
        lo,
      );
    }
  }
  await state.serviceRegistry.quiesceScopeServices(state.ctx.stepExecId);
  const scopeReceipt = await inspectLoopActScopeReceipt(state);
  const latestLeaf =
    updatedLoop.preservedActLeafMessageId ??
    resumeLeaf ??
    `msg:${state.ctx.stepExecId}:assistant:${String(updatedLoop.actTurnsTaken)}`;
  state.loopFrame = Object.freeze<LoopContinuationFrame>({
    ...updatedLoop,
    phase: 'evaluate',
    lastActModelId: state.currentActModelNode.modelId,
    preservedActLeafMessageId: latestLeaf,
    lastActOutputJson: JSON.stringify(actOutput),
    lastActScopeReceiptJson: JSON.stringify(scopeReceipt),
    accumulatedLessonOutcomes: Object.freeze({ ...state.accumulatedLessonOutcomes }),
  });
  if (state.ledgerStore !== undefined) {
    const ledgerStore = state.ledgerStore;
    await state.continuationQueue.enqueueUpdate(state.ctx.stepExecId, () =>
      ledgerStore.updateContinuationStack(
        state.ctx.runId,
        state.ctx.stepExecId,
        Object.freeze<readonly ContinuationFrame[]>([...state.outerFrames, state.loopFrame]),
      ),
    );
  }
  return actOutput;
}
