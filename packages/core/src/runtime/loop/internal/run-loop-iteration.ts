import type { AgentContinuationFrame } from '../../../ports/agent-continuation-frame.js';
import type { ContinuationFrame } from '../../../ports/continuation-frame.types.js';
import type { IsolationScope } from '../../../ports/isolation-scope.js';
import type { LoopContinuationFrame } from '../../../ports/loop-continuation-frame.js';
import type { StepExecutionContext } from '../../../ports/step-execution-context.js';
import type { WireFrameRecord } from '../../../ports/wire-frame-record.js';
import { executeAgent } from '../../agent/execute-agent.js';
import { runContrastiveLessonDistillation } from '../../lessons/lesson-distiller-runner.js';
import { mergeLessonOutcomePrecedence } from '../../lessons/lesson-scoring.js';
import type { LoopEvaluatePhaseResult, LoopExecutionState } from '../loop-execution-state.js';

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
  const nextDriver = nextDriverFactory(nextModel as never, { registry: state.ctx.registry, resolveEnv: (v) => (typeof v === 'string' ? v : undefined), getRunner: (n) => { const f = state.ctx.registry.runners[n.type]; if (f === undefined) throw new Error(n.type); return f(n as never); } });
  const sourceHistory = await state.ledgerStore.getMessageChain(state.loopFrame.preservedActLeafMessageId);
  const forkedHistory = await nextDriver.prepareFork({ historyMode: 'clone-transcript', parentChain: sourceHistory, forkPointMessageId: state.loopFrame.preservedActLeafMessageId }, { modelId: nextModel.modelId, effort: nextModel.effort, substituteTombstones: true });
  const msgIdMap = new Map<string, string>();
  let newLeafId = state.loopFrame.preservedActLeafMessageId;
  for (let idx = 0; idx < forkedHistory.length; idx += 1) {
    const oldFrame = sourceHistory[idx], newFrame = forkedHistory[idx] as WireFrameRecord;
    if (oldFrame !== undefined) msgIdMap.set(oldFrame.messageId, newFrame.messageId);
    await state.ledgerStore.appendMessageFrame(state.ctx.runId, newFrame);
    newLeafId = newFrame.messageId;
  }
  const remappedActivations: Record<string, { readonly messageId: string; readonly callId: string }> = {};
  for (const [skillId, coord] of Object.entries(state.loopFrame.activeSkillActivations)) {
    remappedActivations[skillId] = Object.freeze({ messageId: msgIdMap.get(coord.messageId) ?? coord.messageId, callId: coord.callId });
  }
  state.loopFrame = Object.freeze<LoopContinuationFrame>({
    ...state.loopFrame,
    lastActModelId: nextModel.modelId,
    preservedActLeafMessageId: newLeafId,
    activeSkillActivations: Object.freeze(remappedActivations),
  });
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
  await escalateLoopActorModelIfNeeded(state);
  const actor = state.node.actStep.actor;
  const resumeLeaf = state.node.preserveActorSession ? state.loopFrame.preservedActLeafMessageId : null;
  const existingAgentFrame: AgentContinuationFrame | undefined = resumeLeaf !== null ? Object.freeze<AgentContinuationFrame>({ kind: 'agent-frame', agentId: actor.id, roleKey: actor.roleKey, modelId: state.currentActModelNode.modelId, stepExecId: state.ctx.stepExecId, inputJson: state.loopFrame.loopInputJson, leafMessageId: resumeLeaf, turnsTaken: state.loopFrame.actTurnsTaken, costUsd: state.loopFrame.actCostUsd, elapsedDurationMs: state.loopFrame.actElapsedDurationMs, activeLeases: state.loopFrame.grantedLoopLeases, activeSkillIds: state.loopFrame.activeSkillIds, activeSkillActivations: state.loopFrame.activeSkillActivations, observedEffects: state.loopFrame.observedEffects, injectedScopedRuleIds: state.loopFrame.injectedScopedRuleIds, pausedAtPhase: 'TOOL_BOUNDARY', pauseState: Object.freeze({ kind: 'active-turn' }), conflictCheckArmed: state.loopFrame.conflictCheckArmed, accumulatedLessonOutcomes: state.accumulatedLessonOutcomes }) : undefined;
  const outerForAct: ContinuationFrame[] = [...state.outerFrames, state.loopFrame];
  const actCtx = Object.freeze({ ...state.ctx, _runtime: { ledgerStore: state.ledgerStore, topologyStore: state.topologyStore, lessonStore: state.lessonStore, lockManager: state.lockManager, continuationQueue: state.continuationQueue, poolManager: state.poolManager, serviceRegistry: state.serviceRegistry, humanAdaptersById: state.humanAdaptersById, wirePrefixesByGroupId: state.wirePrefixesByGroupId, outerFrames: outerForAct, existingAgentFrame, overrideModelNode: state.currentActModelNode } }) as StepExecutionContext<THandle>;
  const actOutput = await executeAgent(actor, state.validatedInput, actCtx);
  const updatedLoop = outerForAct[outerForAct.length - 1] as LoopContinuationFrame;
  await state.serviceRegistry.quiesceScopeServices(state.ctx.stepExecId);
  const scopeFactory = state.ctx.scopeNode !== undefined ? state.ctx.registry.scopes[state.ctx.scopeNode.type] : undefined;
  const scopeDriver = (scopeFactory !== undefined && state.ctx.scopeNode !== undefined ? scopeFactory(state.ctx.scopeNode as never, { registry: state.ctx.registry, resolveEnv: (v) => (typeof v === 'string' ? v : undefined), getRunner: (n) => { const f = state.ctx.registry.runners[n.type]; if (f === undefined) throw new Error(n.type); return f(n as never); } }) : undefined) as IsolationScope<THandle> | undefined;
  const scopeReceipt = scopeDriver !== undefined ? await state.lockManager.withReadLock(state.ctx.scopeHandle, () => scopeDriver.inspect(state.ctx.scopeHandle)) : {};
  const latestLeaf = resumeLeaf ?? `msg:${state.ctx.stepExecId}:assistant:${String(updatedLoop.actTurnsTaken)}`;
  state.loopFrame = Object.freeze<LoopContinuationFrame>({ ...updatedLoop, phase: 'evaluate', lastActModelId: state.currentActModelNode.modelId, preservedActLeafMessageId: latestLeaf, lastActOutputJson: JSON.stringify(actOutput), lastActScopeReceiptJson: JSON.stringify(scopeReceipt), accumulatedLessonOutcomes: Object.freeze({ ...state.accumulatedLessonOutcomes }) });
  if (state.ledgerStore !== undefined) {
    const stack: readonly ContinuationFrame[] = Object.freeze([...state.outerFrames, state.loopFrame]);
    await state.continuationQueue.enqueueUpdate(state.ctx.stepExecId, () => (state.ledgerStore as NonNullable<typeof state.ledgerStore>).updateContinuationStack(state.ctx.runId, state.ctx.stepExecId, stack));
  }
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
export async function runLoopEvaluatePhase<TIn, TOut, THandle>(
  state: LoopExecutionState<TIn, TOut, THandle>,
): Promise<LoopEvaluatePhaseResult<TOut>> {
  const actOutput = JSON.parse(state.loopFrame.lastActOutputJson ?? 'null') as TOut, scopeReceipt = JSON.parse(state.loopFrame.lastActScopeReceiptJson ?? '{}') as Record<string, unknown>;
  const evalInput = state.node.evaluateStep.mapInput(state.validatedInput, actOutput, scopeReceipt), outerForEval: ContinuationFrame[] = [...state.outerFrames, state.loopFrame];
  const evalCtx = Object.freeze({ ...state.ctx, _runtime: { ledgerStore: state.ledgerStore, topologyStore: state.topologyStore, lessonStore: state.lessonStore, lockManager: state.lockManager, continuationQueue: state.continuationQueue, poolManager: state.poolManager, serviceRegistry: state.serviceRegistry, humanAdaptersById: state.humanAdaptersById, wirePrefixesByGroupId: state.wirePrefixesByGroupId, outerFrames: outerForEval } }) as StepExecutionContext<THandle>;
  const evalOutput = await executeAgent(state.node.evaluateStep.evaluator, evalInput, evalCtx), updatedLoop = outerForEval[outerForEval.length - 1] as LoopContinuationFrame;
  await state.serviceRegistry.quiesceScopeServices(state.ctx.stepExecId);
  if (typeof evalOutput === 'object' && evalOutput !== null && '_harnessMeta' in evalOutput) {
    const meta = (evalOutput as { readonly _harnessMeta?: { readonly violatedLessonIds?: readonly string[] } })._harnessMeta;
    for (const vid of meta?.violatedLessonIds ?? []) state.accumulatedLessonOutcomes[vid] = mergeLessonOutcomePrecedence(state.accumulatedLessonOutcomes[vid], 'violated');
  }
  if (!state.node.evaluateStep.acceptWhen(evalOutput)) {
    if ((state.node.actStep.actor.model as { readonly type?: string }).type === 'harness:pool') state.poolManager.recordModelOutcome((state.node.actStep.actor.model as { readonly id: string }).id, state.currentActModelNode.modelId, false);
    const feedback = state.node.evaluateStep.feedbackMapper(evalOutput);
    for (const l of state.loopFrame.recalledLessons) state.accumulatedLessonOutcomes[l.id] = mergeLessonOutcomePrecedence(state.accumulatedLessonOutcomes[l.id], 'gate_rejected_unrecovered');
    let nextLeaf = updatedLoop.preservedActLeafMessageId;
    if (state.node.preserveActorSession && state.ledgerStore !== undefined && nextLeaf !== null) {
      const fbMsgId = `msg:${state.ctx.stepExecId}:eval-reject:${String(updatedLoop.iteration)}`, fbText = `[EVALUATOR_REJECTED]\n${feedback}`;
      await state.ledgerStore.appendMessageFrame(state.ctx.runId, Object.freeze<WireFrameRecord>({ messageId: fbMsgId, parentMessageId: nextLeaf, vendorId: 'harness-loop', rawWireFrame: new TextEncoder().encode(fbText), canonical: Object.freeze({ role: 'user', visibleText: fbText }), prefixDigest: 'loop-feedback' }));
      nextLeaf = fbMsgId;
    }
    state.loopFrame = Object.freeze<LoopContinuationFrame>({ ...updatedLoop, iteration: updatedLoop.iteration + 1, phase: 'act', preservedActLeafMessageId: nextLeaf, lastRejectedIterationJson: JSON.stringify({ output: actOutput, scopeReceipt, evaluatorFeedback: feedback, deficits: [feedback] }), accumulatedLessonOutcomes: Object.freeze({ ...state.accumulatedLessonOutcomes }) });
    return Object.freeze<LoopEvaluatePhaseResult<TOut>>({ accepted: false, actOutput, feedback, evaluatorOutput: evalOutput });
  }
  const hadPriorReject = updatedLoop.lastRejectedIterationJson !== undefined;
  for (const l of state.loopFrame.recalledLessons) {
    const prev = state.accumulatedLessonOutcomes[l.id];
    if (hadPriorReject && (prev === 'gate_rejected_unrecovered' || prev === undefined)) state.accumulatedLessonOutcomes[l.id] = 'gate_rejected_recovered';
    else if (prev === undefined) state.accumulatedLessonOutcomes[l.id] = 'clean_pass';
  }
  if (hadPriorReject && state.node.distillLessons?.distillation?.onLoopRecovery !== undefined && state.lessonStore !== undefined && updatedLoop.lastRejectedIterationJson !== undefined) {
    const rej = JSON.parse(updatedLoop.lastRejectedIterationJson) as { readonly output: unknown; readonly scopeReceipt?: Record<string, unknown>; readonly evaluatorFeedback?: string; readonly deficits: readonly string[] };
    await runContrastiveLessonDistillation({ lessonsNode: state.node.distillLessons, lessonStore: state.lessonStore, topologyStore: state.topologyStore, trajectory: { source: 'loop', rejected: rej, accepted: { output: actOutput, scopeReceipt } }, ctx: state.ctx as never, poolManager: state.poolManager });
  }
  return Object.freeze<LoopEvaluatePhaseResult<TOut>>({ accepted: true, actOutput, evaluatorOutput: evalOutput });
}
