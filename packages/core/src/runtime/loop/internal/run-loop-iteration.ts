import { z } from 'zod';
import type { AgentContinuationFrame } from '../../../ports/agent-continuation-frame.js';
import type { ContinuationFrame } from '../../../ports/continuation-frame.types.js';
import type { IsolationScope } from '../../../ports/isolation-scope.js';
import type { LoopContinuationFrame } from '../../../ports/loop-continuation-frame.js';
import type { StepExecutionContext } from '../../../ports/step-execution-context.js';
import type { WireFrameRecord } from '../../../ports/wire-frame-record.js';
import { executeAgent } from '../../agent/execute-agent.js';
import type { ContrastiveDistillationTrajectoryPair } from '../../lessons/lesson-distillation-params.js';
import { runContrastiveLessonDistillation } from '../../lessons/lesson-distiller-runner.js';
import { mergeLessonOutcomePrecedence } from '../../lessons/lesson-scoring.js';
import type { LoopEvaluatePhaseResult } from '../loop-evaluate-phase-result.js';
import type { LoopExecutionState } from '../loop-execution-state.js';

/**
 * Escalates the `.act()` actor's model on retry iterations and migrates the preserved transcript via `ModelDriver.prepareFork` (`SPEC.md` §3.8).
 *
 * Substitutes tombstones (`substituteTombstones: true`) and remaps `activeSkillActivations` `messageId` coordinates when switching models.
 *
 * @template TIn     Validated loop input payload type.
 * @template TOut    Validated loop output payload type.
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {LoopExecutionState<TIn, TOut, THandle>} state - Active loop execution state.
 *
 * @returns {Promise<void>} Resolves once model selection and any cross-model transcript fork are complete.
 */
export async function escalateLoopActorModelIfNeeded<TIn, TOut, THandle>(
  state: LoopExecutionState<TIn, TOut, THandle>,
): Promise<void> {
  if (state.loopFrame.iteration === 0) return;
  const nextModel = state.poolManager.selectModel(state.node.actStep.actor.model, state.ctx.runId, state.loopFrame.iteration);
  if (nextModel.modelId === state.currentActModelNode.modelId) return;
  state.currentActModelNode = nextModel;
  if (!state.node.preserveActorSession || state.loopFrame.preservedActLeafMessageId === null || state.ledgerStore === undefined) {
    state.loopFrame = Object.freeze<LoopContinuationFrame>({ ...state.loopFrame, lastActModelId: nextModel.modelId });
    return;
  }
  const nextDriverFactory = state.ctx.registry.models[nextModel.type];
  if (nextDriverFactory === undefined) throw new Error(`No ModelDriver for '${nextModel.type}' during loop escalation.`);
  const nextDriver = nextDriverFactory(nextModel as never, { registry: state.ctx.registry, resolveEnv: (v) => state.ctx.resolveEnv(v), getRunner: (n) => state.ctx.getRunner(n) });
  const sourceHistory = await state.ledgerStore.getMessageChain(state.loopFrame.preservedActLeafMessageId);
  const forkedHistory = await nextDriver.prepareFork({ historyMode: 'clone-transcript', parentChain: sourceHistory, forkPointMessageId: state.loopFrame.preservedActLeafMessageId }, { modelId: nextModel.modelId, effort: nextModel.effort, substituteTombstones: true });
  const msgIdMap = new Map<string, string>();
  let newLeafId = state.loopFrame.preservedActLeafMessageId;
  for (let idx = 0; idx < forkedHistory.length; idx += 1) {
    const oldFrame = sourceHistory[idx];
    const newFrame = forkedHistory[idx] as WireFrameRecord;
    if (oldFrame !== undefined) msgIdMap.set(oldFrame.messageId, newFrame.messageId);
    await state.ledgerStore.appendMessageFrame(state.ctx.runId, newFrame);
    newLeafId = newFrame.messageId;
  }
  const remappedActivations: Record<string, { readonly messageId: string; readonly callId: string }> = {};
  for (const [skillId, coord] of Object.entries(state.loopFrame.activeSkillActivations)) {
    remappedActivations[skillId] = Object.freeze({ messageId: msgIdMap.get(coord.messageId) ?? coord.messageId, callId: coord.callId });
  }
  state.loopFrame = Object.freeze<LoopContinuationFrame>({ ...state.loopFrame, lastActModelId: nextModel.modelId, preservedActLeafMessageId: newLeafId, activeSkillActivations: Object.freeze(remappedActivations) });
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
  if (state.loopFrame.iteration > 0) await escalateLoopActorModelIfNeeded(state);
  const actor = state.node.actStep.actor;
  const resumedInnerAgent = state.loopFrame.iteration === 0
    ? state.ctx.resumeContinuationStack?.find((f): f is AgentContinuationFrame => f.kind === 'agent-frame' && f.agentId === actor.id)
    : undefined;
  const resumeLeaf = state.node.preserveActorSession ? (state.loopFrame.preservedActLeafMessageId ?? resumedInnerAgent?.leafMessageId ?? null) : (resumedInnerAgent?.leafMessageId ?? null);
  const existingAgentFrame: AgentContinuationFrame | undefined = resumedInnerAgent !== undefined
    ? Object.freeze<AgentContinuationFrame>({ ...resumedInnerAgent, activeLeases: Object.freeze([...state.loopFrame.grantedLoopLeases, ...resumedInnerAgent.activeLeases]) })
    : resumeLeaf !== null
      ? Object.freeze<AgentContinuationFrame>({ kind: 'agent-frame', agentId: actor.id, roleKey: actor.roleKey, modelId: state.currentActModelNode.modelId, stepExecId: state.ctx.stepExecId, inputJson: state.loopFrame.loopInputJson, leafMessageId: resumeLeaf, turnsTaken: state.loopFrame.actTurnsTaken, costUsd: state.loopFrame.actCostUsd, elapsedDurationMs: state.loopFrame.actElapsedDurationMs, activeLeases: state.loopFrame.grantedLoopLeases, activeSkillIds: state.loopFrame.activeSkillIds, activeSkillActivations: state.loopFrame.activeSkillActivations, observedEffects: state.loopFrame.observedEffects, injectedScopedRuleIds: state.loopFrame.injectedScopedRuleIds, pausedAtPhase: 'TOOL_BOUNDARY', pauseState: Object.freeze({ kind: 'active-turn' }), conflictCheckArmed: state.loopFrame.conflictCheckArmed, accumulatedLessonOutcomes: state.accumulatedLessonOutcomes })
      : undefined;
  const outerForAct: ContinuationFrame[] = [...state.outerFrames, state.loopFrame];
  const actOutcomeSink: { continuationStack?: readonly ContinuationFrame[]; suspendedAtCallId?: string } = {};
  const parentRt = (state.ctx as { readonly _runtime?: Record<string, unknown> })._runtime ?? {};
  const actCtx = Object.freeze({ ...state.ctx, resumeContinuationStack: undefined, _runtime: { ...parentRt, ledgerStore: state.ledgerStore, topologyStore: state.topologyStore, lessonStore: state.lessonStore, lockManager: state.lockManager, continuationQueue: state.continuationQueue, poolManager: state.poolManager, serviceRegistry: state.serviceRegistry, humanAdaptersById: state.humanAdaptersById, wirePrefixesByGroupId: state.wirePrefixesByGroupId, outerFrames: outerForAct, existingAgentFrame, overrideModelNode: state.currentActModelNode, childOutcomeSink: actOutcomeSink } }) as StepExecutionContext<THandle>;
  let actOutput: TOut;
  try {
    actOutput = await executeAgent(actor, state.validatedInput, actCtx);
  } finally {
    const innerFrame = actOutcomeSink.continuationStack?.[0];
    Object.assign(state, { lastInnerAgentFrame: innerFrame, lastSuspendedAtCallId: actOutcomeSink.suspendedAtCallId });
    const latestLoop = outerForAct[outerForAct.length - 1];
    if (latestLoop?.kind === 'loop-frame') state.loopFrame = latestLoop;
  }
  const updatedLoop = outerForAct[outerForAct.length - 1] as LoopContinuationFrame;
  for (const [lid, lo] of Object.entries(updatedLoop.accumulatedLessonOutcomes)) state.accumulatedLessonOutcomes[lid] = mergeLessonOutcomePrecedence(state.accumulatedLessonOutcomes[lid], lo);
  await state.serviceRegistry.quiesceScopeServices(state.ctx.stepExecId);
  const scopeFactory = state.ctx.scopeNode !== undefined ? state.ctx.registry.scopes[state.ctx.scopeNode.type] : undefined;
  const scopeDriver = (state.ctx.scope ?? (scopeFactory !== undefined && state.ctx.scopeNode !== undefined ? scopeFactory(state.ctx.scopeNode as never, { registry: state.ctx.registry, resolveEnv: (v) => state.ctx.resolveEnv(v), getRunner: (n) => state.ctx.getRunner(n) }) : undefined)) as IsolationScope<THandle> | undefined;
  const scopeReceipt = scopeDriver !== undefined ? await state.lockManager.withReadLock(state.ctx.scopeHandle, () => scopeDriver.inspect(state.ctx.scopeHandle)) : {};
  const latestLeaf = updatedLoop.preservedActLeafMessageId ?? resumeLeaf ?? `msg:${state.ctx.stepExecId}:assistant:${String(updatedLoop.actTurnsTaken)}`;
  state.loopFrame = Object.freeze<LoopContinuationFrame>({ ...updatedLoop, phase: 'evaluate', lastActModelId: state.currentActModelNode.modelId, preservedActLeafMessageId: latestLeaf, lastActOutputJson: JSON.stringify(actOutput), lastActScopeReceiptJson: JSON.stringify(scopeReceipt), accumulatedLessonOutcomes: Object.freeze({ ...state.accumulatedLessonOutcomes }) });
  if (state.ledgerStore !== undefined) await state.continuationQueue.enqueueUpdate(state.ctx.stepExecId, () => (state.ledgerStore as NonNullable<typeof state.ledgerStore>).updateContinuationStack(state.ctx.runId, state.ctx.stepExecId, Object.freeze<readonly ContinuationFrame[]>([...state.outerFrames, state.loopFrame])));
  return actOutput;
}

/**
 * Executes the `.evaluate()` phase of a loop iteration, isolating evaluator skills and attributing lesson outcomes (`SPEC.md` §3.8).
 *
 * On rejection, injects `[EVALUATOR_REJECTED]` feedback into the preserved `.act()` transcript; on recovery acceptance, runs `.onLoopRecovery()` distillation.
 *
 * @template TIn     Validated loop input payload type.
 * @template TOut    Validated loop output payload type.
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {LoopExecutionState<TIn, TOut, THandle>} state - Active loop execution state.
 *
 * @returns {Promise<LoopEvaluatePhaseResult<TOut>>} Evaluation result indicating acceptance or rejection feedback.
 */
export async function runLoopEvaluatePhase<TIn, TOut, THandle>(state: LoopExecutionState<TIn, TOut, THandle>): Promise<LoopEvaluatePhaseResult<TOut>> {
  const actOutput = JSON.parse(state.loopFrame.lastActOutputJson ?? 'null') as TOut;
  const scopeReceipt = JSON.parse(state.loopFrame.lastActScopeReceiptJson ?? '{}') as Record<string, unknown>;
  const outerForEval: ContinuationFrame[] = [...state.outerFrames, state.loopFrame];
  const evalStepExecId = `${state.ctx.stepExecId}:eval:${String(state.loopFrame.iteration)}${state.ctx.resumeContinuationStack !== undefined ? `:r${String(state.loopFrame.turnsTaken)}` : ''}`;
  const evalCtx = Object.freeze({ ...state.ctx, stepExecId: evalStepExecId, resumeContinuationStack: undefined, _runtime: { ledgerStore: state.ledgerStore, topologyStore: state.topologyStore, lessonStore: state.lessonStore, lockManager: state.lockManager, continuationQueue: state.continuationQueue, poolManager: state.poolManager, serviceRegistry: state.serviceRegistry, humanAdaptersById: state.humanAdaptersById, wirePrefixesByGroupId: state.wirePrefixesByGroupId, outerFrames: outerForEval } }) as StepExecutionContext<THandle>;
  const baseEval = state.node.evaluateStep.evaluator;
  const metaSchema = z.object({ violatedLessonIds: z.array(z.string()).default([]) }).optional();
  const evalActor = (state.node.distillLessons !== undefined || state.loopFrame.recalledLessons.length > 0) && baseEval.outputSchema instanceof z.ZodObject ? Object.freeze({ ...baseEval, outputSchema: (baseEval.outputSchema as z.ZodObject<z.ZodRawShape>).extend({ _harnessMeta: metaSchema }) as never }) : baseEval;
  const rawEvalOut = await executeAgent(evalActor, state.node.evaluateStep.mapInput(state.validatedInput, actOutput, scopeReceipt), evalCtx);
  const updatedLoop = outerForEval[outerForEval.length - 1] as LoopContinuationFrame;
  await state.serviceRegistry.quiesceScopeServices(evalStepExecId);
  const violatedIds: string[] = [];
  let evalOutput: unknown = rawEvalOut;
  if (typeof rawEvalOut === 'object' && rawEvalOut !== null && '_harnessMeta' in rawEvalOut) {
    const { _harnessMeta, ...cleanRest } = rawEvalOut as Record<string, unknown> & { readonly _harnessMeta?: { readonly violatedLessonIds?: readonly string[] } };
    for (const vid of _harnessMeta?.violatedLessonIds ?? []) violatedIds.push((state.accumulatedLessonOutcomes[vid] = mergeLessonOutcomePrecedence(state.accumulatedLessonOutcomes[vid], 'violated'), vid));
    evalOutput = cleanRest;
  }
  if (!state.node.evaluateStep.acceptWhen(evalOutput) || violatedIds.length > 0) {
    if ((state.node.actStep.actor.model as { readonly type?: string }).type === 'harness:pool') state.poolManager.recordModelOutcome((state.node.actStep.actor.model as { readonly id: string }).id, state.currentActModelNode.modelId, false);
    const feedback = state.node.evaluateStep.feedbackMapper(evalOutput);
    const fbText = `[EVALUATOR_REJECTED]\n${feedback}`;
    for (const l of state.loopFrame.recalledLessons) state.accumulatedLessonOutcomes[l.id] = mergeLessonOutcomePrecedence(state.accumulatedLessonOutcomes[l.id], 'gate_rejected_unrecovered');
    let nextLeaf = updatedLoop.preservedActLeafMessageId;
    if (state.node.preserveActorSession && state.ledgerStore !== undefined && nextLeaf !== null) {
      nextLeaf = `msg:${state.ctx.stepExecId}:eval-reject:${String(updatedLoop.iteration)}`;
      await state.ledgerStore.appendMessageFrame(state.ctx.runId, Object.freeze<WireFrameRecord>({ messageId: nextLeaf, parentMessageId: updatedLoop.preservedActLeafMessageId, vendorId: 'harness-loop', rawWireFrame: new TextEncoder().encode(fbText), canonical: Object.freeze({ role: 'user', visibleText: fbText }), prefixDigest: 'loop-feedback' }));
    }
    state.loopFrame = Object.freeze<LoopContinuationFrame>({ ...updatedLoop, iteration: updatedLoop.iteration + 1, phase: 'act', preservedActLeafMessageId: nextLeaf, lastRejectedIterationJson: JSON.stringify({ output: actOutput, scopeReceipt, evaluatorFeedback: feedback, deficits: [feedback] }), accumulatedLessonOutcomes: Object.freeze({ ...state.accumulatedLessonOutcomes }) });
    if (state.ledgerStore !== undefined) await state.continuationQueue.enqueueUpdate(state.ctx.stepExecId, () => (state.ledgerStore as NonNullable<typeof state.ledgerStore>).updateContinuationStack(state.ctx.runId, state.ctx.stepExecId, Object.freeze([...state.outerFrames, state.loopFrame])));
    return Object.freeze<LoopEvaluatePhaseResult<TOut>>({ accepted: false, actOutput, feedback, evaluatorOutput: evalOutput });
  }
  const hadPriorReject = updatedLoop.lastRejectedIterationJson !== undefined;
  const lessonsNode = state.node.distillLessons ?? state.node.actStep.actor.lessons?.node;
  for (const l of state.loopFrame.recalledLessons) state.accumulatedLessonOutcomes[l.id] = hadPriorReject && (state.accumulatedLessonOutcomes[l.id] === 'gate_rejected_unrecovered' || state.accumulatedLessonOutcomes[l.id] === undefined) ? 'gate_rejected_recovered' : (state.accumulatedLessonOutcomes[l.id] ?? 'clean_pass');
  if (lessonsNode !== undefined && state.lessonStore !== undefined) {
    for (const bufGate of (updatedLoop.bufferedGateRecoveries ?? []) as readonly ContrastiveDistillationTrajectoryPair[]) await runContrastiveLessonDistillation({ lessonsNode, lessonStore: state.lessonStore, topologyStore: state.topologyStore, trajectory: bufGate, ctx: state.ctx as never, poolManager: state.poolManager });
    if (hadPriorReject && lessonsNode.distillation?.onLoopRecovery !== undefined && updatedLoop.lastRejectedIterationJson !== undefined) await runContrastiveLessonDistillation({ lessonsNode, lessonStore: state.lessonStore, topologyStore: state.topologyStore, trajectory: { source: 'loop', rejected: JSON.parse(updatedLoop.lastRejectedIterationJson), accepted: { output: actOutput, scopeReceipt } }, ctx: state.ctx as never, poolManager: state.poolManager });
  }
  state.loopFrame = Object.freeze<LoopContinuationFrame>({ ...updatedLoop, bufferedGateRecoveries: undefined, accumulatedLessonOutcomes: Object.freeze({ ...state.accumulatedLessonOutcomes }) });
  if (state.ledgerStore !== undefined) await state.continuationQueue.enqueueUpdate(state.ctx.stepExecId, () => (state.ledgerStore as NonNullable<typeof state.ledgerStore>).updateContinuationStack(state.ctx.runId, state.ctx.stepExecId, Object.freeze([...state.outerFrames, state.loopFrame])));
  return Object.freeze<LoopEvaluatePhaseResult<TOut>>({ accepted: true, actOutput, evaluatorOutput: evalOutput });
}
