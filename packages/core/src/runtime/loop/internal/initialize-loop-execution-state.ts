import type { ModelASTNode } from '../../../ast/domain-ast.types.js';
import type { LoopNode } from '../../../ast/loop-node.js';
import type { ContinuationFrame } from '../../../ports/continuation-frame.types.js';
import type { LessonOutcome } from '../../../ports/lesson-outcome.types.js';
import type { LoopContinuationFrame } from '../../../ports/loop-continuation-frame.js';
import type { StepExecutionContext } from '../../../ports/step-execution-context.js';
import { getStepRuntimeInternals } from '../../agent/internal/get-step-runtime-internals.js';
import { ScopeLockManager } from '../../locks/scope-lock-manager.js';
import { StepContinuationQueue } from '../../locks/step-continuation-queue.js';
import { PoolManager } from '../../pools/pool-manager.js';
import { ServiceSessionRegistry } from '../../services/service-session-registry.js';
import type { LoopExecutionState } from '../loop-execution-state.js';

/**
 * Initializes the `LoopExecutionState` and `LoopContinuationFrame` for a `LoopNode` execution (`SPEC.md` §3.8).
 *
 * Extracts runtime stores and managers, selects the initial `.act()` model, and restores any
 * persisted `LoopContinuationFrame` on resume without introducing unnecessary async microtasks (`Rule 4.5`).
 *
 * @template TIn     Validated loop input payload type.
 * @template TOut    Validated loop output payload type.
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {LoopNode<TIn, TOut, THandle>}  node           - Passive `LoopNode` AST definition.
 * @param {TIn}                           validatedInput - Schema-validated loop input payload.
 * @param {StepExecutionContext<THandle>} ctx            - Active step execution context.
 *
 * @returns {LoopExecutionState<TIn, TOut, THandle>} Initialized loop execution state.
 */
export function initializeLoopExecutionState<
  TIn = unknown,
  TOut = unknown,
  THandle = unknown,
>(
  node: LoopNode<TIn, TOut, THandle>,
  validatedInput: TIn,
  ctx: StepExecutionContext<THandle>,
): LoopExecutionState<TIn, TOut, THandle> {
  const rtEnv = getStepRuntimeInternals(ctx);
  const poolManager = rtEnv?.poolManager ?? new PoolManager();
  const actor = node.actStep.actor;
  const resumedLoopFrame =
    rtEnv?.existingLoopFrame ??
    ctx.resumeContinuationStack?.find((f): f is LoopContinuationFrame => f.kind === 'loop-frame');
  const initialActModel: ModelASTNode = poolManager.selectModel(
    actor.model,
    ctx.runId,
    resumedLoopFrame?.iteration ?? 0,
  );
  const accumulatedLessonOutcomes: Record<string, LessonOutcome> = {
    ...(resumedLoopFrame?.accumulatedLessonOutcomes ?? {}),
  };
  const initialLeases = Object.freeze([
    ...ctx.activeLeases,
    ...(resumedLoopFrame?.grantedLoopLeases ?? []),
  ]);
  const loopFrame: LoopContinuationFrame =
    resumedLoopFrame !== undefined
      ? Object.freeze<LoopContinuationFrame>({
          ...resumedLoopFrame,
          grantedLoopLeases: initialLeases,
        })
      : Object.freeze<LoopContinuationFrame>({
          kind: 'loop-frame',
          loopId: node.id,
          roleKey: node.roleKey,
          lastActModelId: initialActModel.modelId,
          stepExecId: ctx.stepExecId,
          loopInputJson: JSON.stringify(validatedInput),
          iteration: 0,
          phase: 'act',
          preservedActLeafMessageId: null,
          turnsTaken: 0,
          costUsd: 0,
          elapsedDurationMs: 0,
          actTurnsTaken: 0,
          actCostUsd: 0,
          actElapsedDurationMs: 0,
          grantedLoopLeases: initialLeases,
          activeSkillIds: Object.freeze([]),
          activeSkillActivations: Object.freeze({}),
          observedEffects: Object.freeze([]),
          injectedScopedRuleIds: Object.freeze([]),
          recalledLessons: Object.freeze([]),
          accumulatedLessonOutcomes: Object.freeze({}),
        });
  const outerFrames: ContinuationFrame[] =
    rtEnv?.outerFrames !== undefined ? [...rtEnv.outerFrames] : [];
  return {
    node,
    validatedInput,
    ctx,
    loopFrame,
    outerFrames,
    accumulatedLessonOutcomes,
    ledgerStore: rtEnv?.ledgerStore,
    topologyStore: rtEnv?.topologyStore,
    lessonStore: rtEnv?.lessonStore,
    lockManager: rtEnv?.lockManager ?? new ScopeLockManager(),
    continuationQueue: rtEnv?.continuationQueue ?? new StepContinuationQueue(),
    poolManager,
    serviceRegistry: rtEnv?.serviceRegistry ?? new ServiceSessionRegistry(),
    humanAdaptersById: rtEnv?.humanAdaptersById ?? new Map(),
    wirePrefixesByGroupId: rtEnv?.wirePrefixesByGroupId ?? new Map(),
    currentActModelNode: initialActModel,
  };
}
