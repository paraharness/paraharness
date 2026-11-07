import type { ModelASTNode } from '../../ast/domain-ast.types.js';
import type { LoopNode } from '../../ast/loop-node.js';
import type { CompiledWirePrefix } from '../../ports/compiled-wire-prefix.js';
import type { ContinuationFrame } from '../../ports/continuation-frame.types.js';
import type { HumanAdapter } from '../../ports/human-adapter.js';
import type { LedgerStore } from '../../ports/ledger-store.js';
import type { LessonOutcome } from '../../ports/lesson-outcome.types.js';
import type { LessonStore } from '../../ports/lesson-store.js';
import type { LoopContinuationFrame, RecalledLoopLessonRecord } from '../../ports/loop-continuation-frame.js';
import type { StepExecutionContext } from '../../ports/step-execution-context.js';
import type { TopologyStore } from '../../ports/topology-store.js';
import { flushStepLessonOutcomes } from '../lessons/lesson-distiller-runner.js';
import { selectRecalledLessons } from '../lessons/lesson-scoring.js';
import { ScopeLockManager } from '../locks/scope-lock-manager.js';
import { StepContinuationQueue } from '../locks/step-continuation-queue.js';
import { PoolManager } from '../pools/pool-manager.js';
import { ServiceSessionRegistry } from '../services/service-session-registry.js';
import { runLoopActPhase, runLoopEvaluatePhase } from './internal/run-loop-iteration.js';
import type { LoopExecutionState } from './loop-execution-state.js';

/**
 * Executes a passive `LoopNode` across `.act() -> .evaluate()` iterations up to `maxIterations` (`SPEC.md` §3.8).
 *
 * Preserves loop-scoped leases (`grantedLoopLeases`), active skills, and deduplicated lesson outcome attribution,
 * flushing lesson outcomes on acceptance or loop exhaustion while discarding them on `'INTERRUPTED'` aborts.
 *
 * @template TIn     Validated loop input payload type.
 * @template TOut    Validated loop output payload type.
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {LoopNode<TIn, TOut, THandle>}  node  - Passive `LoopNode` AST definition.
 * @param {TIn}                           input - Raw or pre-mapped loop input payload.
 * @param {StepExecutionContext<THandle>} ctx   - Active step execution context.
 *
 * @returns {Promise<TOut>} Schema-validated loop output payload from `returnOutputFromStepId`.
 */
export async function executeLoop<TIn = unknown, TOut = unknown, THandle = unknown>(
  node: LoopNode<TIn, TOut, THandle>,
  input: TIn,
  ctx: StepExecutionContext<THandle>,
): Promise<TOut> {
  const validatedInput = node.inputSchema.parse(input);
  const rtEnv = (ctx as StepExecutionContext<THandle> & {
    readonly _runtime?: {
      readonly ledgerStore?: LedgerStore; readonly topologyStore?: TopologyStore; readonly lessonStore?: LessonStore;
      readonly lockManager?: ScopeLockManager; readonly continuationQueue?: StepContinuationQueue; readonly poolManager?: PoolManager;
      readonly serviceRegistry?: ServiceSessionRegistry; readonly humanAdaptersById?: ReadonlyMap<string, HumanAdapter>;
      readonly wirePrefixesByGroupId?: ReadonlyMap<string, CompiledWirePrefix>; readonly outerFrames?: ContinuationFrame[];
      readonly existingLoopFrame?: LoopContinuationFrame;
      readonly childOutcomeSink?: { continuationStack?: readonly ContinuationFrame[]; leafMessageId?: string | null; accumulatedLessonOutcomes?: Readonly<Record<string, LessonOutcome>>; raisedByPhase?: 'act' | 'evaluate'; suspendedAtCallId?: string };
    };
  })._runtime;
  const poolManager = rtEnv?.poolManager ?? new PoolManager();
  const actor = node.actStep.actor;
  const resumedLoopFrame = rtEnv?.existingLoopFrame ?? ctx.resumeContinuationStack?.find((f): f is LoopContinuationFrame => f.kind === 'loop-frame');
  const initialActModel: ModelASTNode = poolManager.selectModel(actor.model, ctx.runId, resumedLoopFrame?.iteration ?? 0);
  const lessonsNode = node.distillLessons ?? actor.lessons?.node;
  let recalledLessons: readonly RecalledLoopLessonRecord[] = resumedLoopFrame?.recalledLessons ?? [];
  if (recalledLessons.length === 0 && lessonsNode !== undefined && rtEnv?.lessonStore !== undefined) {
    const queryText = lessonsNode.queryMapper !== undefined ? lessonsNode.queryMapper(validatedInput) : JSON.stringify(validatedInput);
    const candidates = await rtEnv.lessonStore.queryCandidates({ queryText, partitions: ctx.activePartitions });
    recalledLessons = selectRecalledLessons(candidates, lessonsNode.scoring, ctx.activePartitions).map((l) => Object.freeze({ id: l.id, partition: l.partition, directive: l.directive }));
  }
  const accumulatedLessonOutcomes: Record<string, LessonOutcome> = { ...(resumedLoopFrame?.accumulatedLessonOutcomes ?? {}) };
  const initialLeases = Object.freeze([...ctx.activeLeases, ...(resumedLoopFrame?.grantedLoopLeases ?? [])]);
  const loopFrame: LoopContinuationFrame = resumedLoopFrame !== undefined
    ? Object.freeze<LoopContinuationFrame>({ ...resumedLoopFrame, grantedLoopLeases: initialLeases })
    : Object.freeze<LoopContinuationFrame>({
      kind: 'loop-frame', loopId: node.id, roleKey: node.roleKey, lastActModelId: initialActModel.modelId, stepExecId: ctx.stepExecId,
      loopInputJson: JSON.stringify(validatedInput), iteration: 0, phase: 'act', preservedActLeafMessageId: null,
      turnsTaken: 0, costUsd: 0, elapsedDurationMs: 0, actTurnsTaken: 0, actCostUsd: 0, actElapsedDurationMs: 0,
      grantedLoopLeases: initialLeases, activeSkillIds: Object.freeze([]), activeSkillActivations: Object.freeze({}),
      observedEffects: Object.freeze([]), injectedScopedRuleIds: Object.freeze([]), recalledLessons, accumulatedLessonOutcomes: Object.freeze({}),
    });
  const outerFrames: ContinuationFrame[] = rtEnv?.outerFrames !== undefined ? [...rtEnv.outerFrames] : [];
  const state: LoopExecutionState<TIn, TOut, THandle> = {
    node, validatedInput, ctx, loopFrame, outerFrames, accumulatedLessonOutcomes,
    ledgerStore: rtEnv?.ledgerStore, topologyStore: rtEnv?.topologyStore, lessonStore: rtEnv?.lessonStore,
    lockManager: rtEnv?.lockManager ?? new ScopeLockManager(), continuationQueue: rtEnv?.continuationQueue ?? new StepContinuationQueue(),
    poolManager, serviceRegistry: rtEnv?.serviceRegistry ?? new ServiceSessionRegistry(),
    humanAdaptersById: rtEnv?.humanAdaptersById ?? new Map(), wirePrefixesByGroupId: rtEnv?.wirePrefixesByGroupId ?? new Map(),
    currentActModelNode: initialActModel,
  };
  const isSpeculative = outerFrames.some((f) => f.kind === 'speculate-frame');
  try {
    while (state.loopFrame.iteration < node.maxIterations) {
      if (state.loopFrame.phase === 'act') await runLoopActPhase(state);
      const evalRes = await runLoopEvaluatePhase(state);
      if (evalRes.accepted) {
        if (!isSpeculative && state.lessonStore !== undefined && lessonsNode !== undefined) await flushStepLessonOutcomes({ lessonsNode, lessonStore: state.lessonStore, accumulatedOutcomes: state.accumulatedLessonOutcomes });
        return node.outputSchema.parse(evalRes.actOutput);
      }
    }
    if (!isSpeculative && state.lessonStore !== undefined && lessonsNode !== undefined) await flushStepLessonOutcomes({ lessonsNode, lessonStore: state.lessonStore, accumulatedOutcomes: state.accumulatedLessonOutcomes });
    throw new Error(`LoopNode '${node.id}' exhausted maxIterations (${String(node.maxIterations)}) in run '${ctx.runId}'.`);
  } finally {
    if (rtEnv?.childOutcomeSink !== undefined) {
      const tracked = state as LoopExecutionState<TIn, TOut, THandle> & {
        readonly lastInnerAgentFrame?: ContinuationFrame;
        readonly lastSuspendedAtCallId?: string;
      };
      rtEnv.childOutcomeSink.continuationStack = tracked.lastInnerAgentFrame !== undefined
        ? Object.freeze([state.loopFrame, tracked.lastInnerAgentFrame])
        : Object.freeze([state.loopFrame]);
      rtEnv.childOutcomeSink.leafMessageId = state.loopFrame.preservedActLeafMessageId ?? (tracked.lastInnerAgentFrame?.kind === 'agent-frame' ? tracked.lastInnerAgentFrame.leafMessageId : null);
      rtEnv.childOutcomeSink.accumulatedLessonOutcomes = Object.freeze({ ...state.accumulatedLessonOutcomes });
      rtEnv.childOutcomeSink.raisedByPhase = state.loopFrame.phase;
      rtEnv.childOutcomeSink.suspendedAtCallId = tracked.lastSuspendedAtCallId;
    }
  }
}
