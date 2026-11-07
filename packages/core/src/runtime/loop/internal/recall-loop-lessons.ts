import type {
  LoopContinuationFrame,
  RecalledLoopLessonRecord,
} from '../../../ports/loop-continuation-frame.js';
import { selectRecalledLessons } from '../../lessons/lesson-scoring.js';
import type { LoopExecutionState } from '../loop-execution-state.js';

/**
 * Checks whether `state` requires an asynchronous Turn-0 lesson query against `state.lessonStore`.
 *
 * Returns `false` when lessons were already recalled on a resumed frame or when no `LessonsNode` / `LessonStore` is bound.
 *
 * @template TIn     Validated loop input payload type.
 * @template TOut    Validated loop output payload type.
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {LoopExecutionState<TIn, TOut, THandle>} state - Active loop execution state.
 *
 * @returns {boolean} True when `recallLoopLessons` should be awaited.
 */
export function shouldRecallLoopLessons<TIn = unknown, TOut = unknown, THandle = unknown>(
  state: LoopExecutionState<TIn, TOut, THandle>,
): boolean {
  if (state.loopFrame.recalledLessons.length > 0) {
    return false;
  }
  const lessonsNode = state.node.distillLessons ?? state.node.actStep.actor.lessons?.node;
  return lessonsNode !== undefined && state.lessonStore !== undefined;
}

/**
 * Recalls top-scoring empirical lessons for `state` at Turn 0 and updates `state.loopFrame.recalledLessons` (`SPEC.md` §3.4.3 & §3.8).
 *
 * Queries `lessonStore.queryCandidates` with `lessonsNode.queryMapper(validatedInput)` and
 * ranks candidates via `selectRecalledLessons`.
 *
 * @template TIn     Validated loop input payload type.
 * @template TOut    Validated loop output payload type.
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {LoopExecutionState<TIn, TOut, THandle>} state - Active loop execution state.
 *
 * @returns {Promise<readonly RecalledLoopLessonRecord[]>} Frozen recalled lesson records for the loop.
 */
export async function recallLoopLessons<TIn = unknown, TOut = unknown, THandle = unknown>(
  state: LoopExecutionState<TIn, TOut, THandle>,
): Promise<readonly RecalledLoopLessonRecord[]> {
  if (state.loopFrame.recalledLessons.length > 0) {
    return state.loopFrame.recalledLessons;
  }
  const lessonsNode = state.node.distillLessons ?? state.node.actStep.actor.lessons?.node;
  if (lessonsNode === undefined || state.lessonStore === undefined) {
    return state.loopFrame.recalledLessons;
  }
  const queryText =
    lessonsNode.queryMapper !== undefined
      ? lessonsNode.queryMapper(state.validatedInput)
      : JSON.stringify(state.validatedInput);
  const candidates = await state.lessonStore.queryCandidates({
    queryText,
    partitions: state.ctx.activePartitions,
  });
  const selected = selectRecalledLessons(
    candidates,
    lessonsNode.scoring,
    state.ctx.activePartitions,
  );
  const recalled: RecalledLoopLessonRecord[] = [];
  for (const lesson of selected) {
    recalled.push(
      Object.freeze<RecalledLoopLessonRecord>({
        id: lesson.id,
        partition: lesson.partition,
        directive: lesson.directive,
      }),
    );
  }
  const frozenRecalled = Object.freeze(recalled);
  state.loopFrame = Object.freeze<LoopContinuationFrame>({
    ...state.loopFrame,
    recalledLessons: frozenRecalled,
  });
  return frozenRecalled;
}
