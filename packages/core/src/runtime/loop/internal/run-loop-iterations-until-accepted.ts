import { flushStepLessonOutcomes } from '../../lessons/internal/flush-step-lesson-outcomes.js';
import type { LoopExecutionState } from '../loop-execution-state.js';
import { recallLoopLessons, shouldRecallLoopLessons } from './recall-loop-lessons.js';
import { runLoopActPhase } from './run-loop-act-phase.js';
import { runLoopEvaluatePhase } from './run-loop-evaluate-phase.js';

/**
 * Flushes accumulated loop lesson outcomes to `state.lessonStore` unless executing inside a speculative tournament branch (`SPEC.md` §3.4.3 & §3.8).
 *
 * Speculative branches buffer lesson outcomes until the winning branch commits (`WINNER_COMMITTED`).
 *
 * @template TIn     Validated loop input payload type.
 * @template TOut    Validated loop output payload type.
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {LoopExecutionState<TIn, TOut, THandle>} state - Active loop execution state.
 *
 * @returns {Promise<void>} Resolves once lesson outcomes are flushed (or skipped if speculative).
 */
async function flushLoopLessonOutcomesIfEligible<TIn, TOut, THandle>(
  state: LoopExecutionState<TIn, TOut, THandle>,
): Promise<void> {
  const isSpeculative = state.outerFrames.some((f) => f.kind === 'speculate-frame');
  const lessonsNode = state.node.distillLessons ?? state.node.actStep.actor.lessons?.node;
  if (!isSpeculative && state.lessonStore !== undefined && lessonsNode !== undefined) {
    await flushStepLessonOutcomes({
      lessonsNode,
      lessonStore: state.lessonStore,
      accumulatedOutcomes: state.accumulatedLessonOutcomes,
    });
  }
}

/**
 * Runs `.act() -> .evaluate()` loop iterations until accepted or `maxIterations` is exhausted (`SPEC.md` §3.8).
 *
 * Recalls Turn-0 empirical lessons when configured, executes each iteration, and flushes deduplicated
 * lesson outcomes on acceptance and on `maxIterations` exhaustion before throwing.
 *
 * @template TIn     Validated loop input payload type.
 * @template TOut    Validated loop output payload type.
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {LoopExecutionState<TIn, TOut, THandle>} state - Active loop execution state.
 *
 * @returns {Promise<TOut>} Accepted `.act()` output payload.
 *
 * @throws {Error} If `state.loopFrame.iteration` reaches `state.node.maxIterations` without acceptance.
 */
export async function runLoopIterationsUntilAccepted<
  TIn = unknown,
  TOut = unknown,
  THandle = unknown,
>(state: LoopExecutionState<TIn, TOut, THandle>): Promise<TOut> {
  if (shouldRecallLoopLessons(state)) {
    await recallLoopLessons(state);
  }
  while (state.loopFrame.iteration < state.node.maxIterations) {
    if (state.loopFrame.phase === 'act') {
      await runLoopActPhase(state);
    }
    const evalRes = await runLoopEvaluatePhase(state);
    if (evalRes.accepted) {
      await flushLoopLessonOutcomesIfEligible(state);
      return evalRes.actOutput;
    }
  }
  await flushLoopLessonOutcomesIfEligible(state);
  throw new Error(
    `LoopNode '${state.node.id}' exhausted maxIterations (${String(state.node.maxIterations)}) in run '${state.ctx.runId}'.`,
  );
}
