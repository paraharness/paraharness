import { z } from 'zod';
import type { ContinuationFrame } from '../../../ports/continuation-frame.types.js';
import type { LoopContinuationFrame } from '../../../ports/loop-continuation-frame.js';
import type { StepExecutionContext } from '../../../ports/step-execution-context.js';
import type { WireFrameRecord } from '../../../ports/wire-frame-record.js';
import { executeAgent } from '../../agent/execute-agent.js';
import { getStepRuntimeInternals } from '../../agent/internal/get-step-runtime-internals.js';
import type { ContrastiveDistillationTrajectoryPair } from '../../lessons/lesson-distillation-params.js';
import { runContrastiveLessonDistillation } from '../../lessons/lesson-distiller-runner.js';
import { mergeLessonOutcomePrecedence } from '../../lessons/lesson-scoring.js';
import type { LoopEvaluatePhaseResult } from '../loop-evaluate-phase-result.js';
import type { LoopExecutionState } from '../loop-execution-state.js';

/**
 * Extracts and strips `_harnessMeta.violatedLessonIds` from the raw evaluator output (`SPEC.md` §3.4.3).
 *
 * Records `'violated'` precedence in `state.accumulatedLessonOutcomes` for each violated lesson ID.
 *
 * @template TIn     Validated loop input payload type.
 * @template TOut    Validated loop output payload type.
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {LoopExecutionState<TIn, TOut, THandle>} state      - Active loop execution state.
 * @param {unknown}                                rawEvalOut - Raw evaluator output payload.
 *
 * @returns {{ readonly evalOutput: unknown; readonly violatedIds: readonly string[] }} Cleaned evaluator output and violated lesson IDs.
 */
function extractEvaluatorHarnessMeta<TIn, TOut, THandle>(
  state: LoopExecutionState<TIn, TOut, THandle>,
  rawEvalOut: unknown,
): { readonly evalOutput: unknown; readonly violatedIds: readonly string[] } {
  if (typeof rawEvalOut !== 'object' || rawEvalOut === null || !('_harnessMeta' in rawEvalOut)) {
    return { evalOutput: rawEvalOut, violatedIds: Object.freeze([]) };
  }
  const { _harnessMeta, ...cleanRest } = rawEvalOut as Record<string, unknown> & {
    readonly _harnessMeta?: { readonly violatedLessonIds?: readonly string[] };
  };
  const violatedIds: string[] = [];
  for (const vid of _harnessMeta?.violatedLessonIds ?? []) {
    state.accumulatedLessonOutcomes[vid] = mergeLessonOutcomePrecedence(
      state.accumulatedLessonOutcomes[vid],
      'violated',
    );
    violatedIds.push(vid);
  }
  return { evalOutput: cleanRest, violatedIds: Object.freeze(violatedIds) };
}

/**
 * Rejected `.act()` output, scope receipt, and evaluator output passed to `handleLoopEvaluationRejection`.
 *
 * @template TOut Validated loop output payload type.
 */
interface HandleLoopEvaluationRejectionParams<TOut> {
  /** Output produced by the `.act()` phase in the current iteration. */
  readonly actOutput: TOut;

  /** Isolation scope inspection receipt captured after `.act()`. */
  readonly scopeReceipt: Record<string, unknown>;

  /** Cleaned evaluator output payload that rejected the iteration. */
  readonly evalOutput: unknown;
}

/**
 * Handles an evaluator rejection by recording `'gate_rejected_unrecovered'`, appending `[EVALUATOR_REJECTED]`, and advancing `iteration` (`SPEC.md` §3.8).
 *
 * Persists `lastRejectedIterationJson` for subsequent `.onLoopRecovery()` contrastive distillation.
 *
 * @template TIn     Validated loop input payload type.
 * @template TOut    Validated loop output payload type.
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {LoopExecutionState<TIn, TOut, THandle>}    state       - Active loop execution state.
 * @param {LoopContinuationFrame}                     updatedLoop - Updated loop continuation frame after `.evaluate()`.
 * @param {HandleLoopEvaluationRejectionParams<TOut>} rejection   - Rejected `.act()` output, scope receipt, and evaluator output.
 *
 * @returns {Promise<LoopEvaluatePhaseResult<TOut>>} Rejected evaluation result with feedback.
 */
async function handleLoopEvaluationRejection<TIn, TOut, THandle>(
  state: LoopExecutionState<TIn, TOut, THandle>,
  updatedLoop: LoopContinuationFrame,
  rejection: HandleLoopEvaluationRejectionParams<TOut>,
): Promise<LoopEvaluatePhaseResult<TOut>> {
  const actorModel = state.node.actStep.actor.model as {
    readonly type?: string;
    readonly id?: string;
  };
  if (actorModel.type === 'harness:pool' && actorModel.id !== undefined) {
    state.poolManager.recordModelOutcome(actorModel.id, state.currentActModelNode.modelId, false);
  }
  const feedback = state.node.evaluateStep.feedbackMapper(rejection.evalOutput);
  const fbText = `[EVALUATOR_REJECTED]\n${feedback}`;
  for (const lesson of state.loopFrame.recalledLessons) {
    state.accumulatedLessonOutcomes[lesson.id] = mergeLessonOutcomePrecedence(
      state.accumulatedLessonOutcomes[lesson.id],
      'gate_rejected_unrecovered',
    );
  }
  let nextLeaf = updatedLoop.preservedActLeafMessageId;
  if (state.node.preserveActorSession && state.ledgerStore !== undefined && nextLeaf !== null) {
    nextLeaf = `msg:${state.ctx.stepExecId}:eval-reject:${String(updatedLoop.iteration)}`;
    await state.ledgerStore.appendMessageFrame(
      state.ctx.runId,
      Object.freeze<WireFrameRecord>({
        messageId: nextLeaf,
        parentMessageId: updatedLoop.preservedActLeafMessageId,
        vendorId: 'harness-loop',
        rawWireFrame: new TextEncoder().encode(fbText),
        canonical: Object.freeze({ role: 'user', visibleText: fbText }),
        prefixDigest: 'loop-feedback',
      }),
    );
  }
  state.loopFrame = Object.freeze<LoopContinuationFrame>({
    ...updatedLoop,
    iteration: updatedLoop.iteration + 1,
    phase: 'act',
    preservedActLeafMessageId: nextLeaf,
    lastRejectedIterationJson: JSON.stringify({
      output: rejection.actOutput,
      scopeReceipt: rejection.scopeReceipt,
      evaluatorFeedback: feedback,
      deficits: [feedback],
    }),
    accumulatedLessonOutcomes: Object.freeze({ ...state.accumulatedLessonOutcomes }),
  });
  if (state.ledgerStore !== undefined) {
    const ledgerStore = state.ledgerStore;
    await state.continuationQueue.enqueueUpdate(state.ctx.stepExecId, () =>
      ledgerStore.updateContinuationStack(
        state.ctx.runId,
        state.ctx.stepExecId,
        Object.freeze([...state.outerFrames, state.loopFrame]),
      ),
    );
  }
  return Object.freeze<LoopEvaluatePhaseResult<TOut>>({
    accepted: false,
    actOutput: rejection.actOutput,
    feedback,
    evaluatorOutput: rejection.evalOutput,
  });
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
  const actOutput = JSON.parse(state.loopFrame.lastActOutputJson ?? 'null') as TOut;
  const scopeReceipt = JSON.parse(state.loopFrame.lastActScopeReceiptJson ?? '{}') as Record<
    string,
    unknown
  >;
  const outerForEval: ContinuationFrame[] = [...state.outerFrames, state.loopFrame];
  const resumeSuffix =
    state.ctx.resumeContinuationStack !== undefined ? `:r${String(state.loopFrame.turnsTaken)}` : '';
  const evalStepExecId = `${state.ctx.stepExecId}:eval:${String(state.loopFrame.iteration)}${resumeSuffix}`;
  const parentRt = getStepRuntimeInternals(state.ctx);
  const evalCtx = Object.freeze({
    ...state.ctx,
    stepExecId: evalStepExecId,
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
      outerFrames: outerForEval,
    },
  }) as StepExecutionContext<THandle>;
  const baseEval = state.node.evaluateStep.evaluator;
  const metaSchema = z.object({ violatedLessonIds: z.array(z.string()).default([]) }).optional();
  const shouldInjectMeta =
    (state.node.distillLessons !== undefined || state.loopFrame.recalledLessons.length > 0) &&
    baseEval.outputSchema instanceof z.ZodObject;
  const evalActor = shouldInjectMeta
    ? Object.freeze({
        ...baseEval,
        outputSchema: (baseEval.outputSchema as z.ZodObject<z.ZodRawShape>).extend({
          _harnessMeta: metaSchema,
        }) as never,
      })
    : baseEval;
  const evalInput = state.node.evaluateStep.mapInput(state.validatedInput, actOutput, scopeReceipt);
  let rawEvalOut: unknown;
  try {
    rawEvalOut = await executeAgent(evalActor, evalInput, evalCtx);
  } finally {
    const latestLoop = outerForEval[outerForEval.length - 1];
    if (latestLoop?.kind === 'loop-frame') {
      state.loopFrame = latestLoop;
    }
  }
  const updatedLoop = outerForEval[outerForEval.length - 1] as LoopContinuationFrame;
  await state.serviceRegistry.quiesceScopeServices(evalStepExecId);
  const { evalOutput, violatedIds } = extractEvaluatorHarnessMeta(state, rawEvalOut);
  if (!state.node.evaluateStep.acceptWhen(evalOutput) || violatedIds.length > 0) {
    return handleLoopEvaluationRejection(state, updatedLoop, {
      actOutput,
      scopeReceipt,
      evalOutput,
    });
  }
  const hadPriorReject = updatedLoop.lastRejectedIterationJson !== undefined;
  const lessonsNode = state.node.distillLessons ?? state.node.actStep.actor.lessons?.node;
  for (const lesson of state.loopFrame.recalledLessons) {
    const prev = state.accumulatedLessonOutcomes[lesson.id];
    const isRecovered =
      hadPriorReject && (prev === 'gate_rejected_unrecovered' || prev === undefined);
    state.accumulatedLessonOutcomes[lesson.id] = isRecovered
      ? 'gate_rejected_recovered'
      : (prev ?? 'clean_pass');
  }
  if (lessonsNode !== undefined && state.lessonStore !== undefined) {
    const bufferedGates = (updatedLoop.bufferedGateRecoveries ??
      []) as readonly ContrastiveDistillationTrajectoryPair[];
    for (const bufGate of bufferedGates) {
      await runContrastiveLessonDistillation({
        lessonsNode,
        lessonStore: state.lessonStore,
        topologyStore: state.topologyStore,
        trajectory: bufGate,
        ctx: state.ctx as never,
        poolManager: state.poolManager,
      });
    }
    if (
      hadPriorReject &&
      lessonsNode.distillation?.onLoopRecovery !== undefined &&
      updatedLoop.lastRejectedIterationJson !== undefined
    ) {
      await runContrastiveLessonDistillation({
        lessonsNode,
        lessonStore: state.lessonStore,
        topologyStore: state.topologyStore,
        trajectory: {
          source: 'loop',
          rejected: JSON.parse(updatedLoop.lastRejectedIterationJson),
          accepted: { output: actOutput, scopeReceipt },
        },
        ctx: state.ctx as never,
        poolManager: state.poolManager,
      });
    }
  }
  state.loopFrame = Object.freeze<LoopContinuationFrame>({
    ...updatedLoop,
    bufferedGateRecoveries: undefined,
    accumulatedLessonOutcomes: Object.freeze({ ...state.accumulatedLessonOutcomes }),
  });
  if (state.ledgerStore !== undefined) {
    const ledgerStore = state.ledgerStore;
    await state.continuationQueue.enqueueUpdate(state.ctx.stepExecId, () =>
      ledgerStore.updateContinuationStack(
        state.ctx.runId,
        state.ctx.stepExecId,
        Object.freeze([...state.outerFrames, state.loopFrame]),
      ),
    );
  }
  return Object.freeze<LoopEvaluatePhaseResult<TOut>>({
    accepted: true,
    actOutput,
    evaluatorOutput: evalOutput,
  });
}
