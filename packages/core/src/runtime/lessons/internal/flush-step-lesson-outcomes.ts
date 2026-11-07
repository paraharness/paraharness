import type { FlushStepLessonOutcomesParams } from '../flush-step-lesson-outcomes-params.js';
import { shouldRetireLesson } from '../lesson-scoring.js';
import { evaluateLessonSignalTriggers } from './evaluate-lesson-signal-triggers.js';

/**
 * Flushes deduplicated per-step lesson outcomes to `LessonStore`, retires degraded lessons, and evaluates signal triggers (`SPEC.md` §3.4.3).
 *
 * Ensures each `(stepExecId, lessonId)` records at most one outcome on step or winner completion.
 *
 * @param {FlushStepLessonOutcomesParams} params - Flush parameters, accumulated outcome map, and stores.
 *
 * @returns {Promise<readonly string[]>} Identifiers of any lessons retired after recording outcomes.
 */
export async function flushStepLessonOutcomes(
  params: FlushStepLessonOutcomesParams,
): Promise<readonly string[]> {
  const entries: Array<{
    readonly lessonId: string;
    readonly outcome: typeof params.accumulatedOutcomes[string];
  }> = [];
  for (const lessonId in params.accumulatedOutcomes) {
    if (!Object.hasOwn(params.accumulatedOutcomes, lessonId)) {
      continue;
    }
    const outcome = params.accumulatedOutcomes[lessonId];
    if (outcome !== undefined) {
      entries.push({ lessonId, outcome });
    }
  }
  if (entries.length === 0) {
    return Object.freeze([]);
  }
  const updated = await params.lessonStore.recordOutcomes(entries);
  const retiredIds: string[] = [];
  const surviving = [];
  for (const lesson of updated) {
    if (
      shouldRetireLesson(
        lesson,
        params.lessonsNode.retireAfter,
        params.lessonsNode.scoring.slidingWindowInjections,
      )
    ) {
      retiredIds.push(lesson.id);
    } else {
      surviving.push(lesson);
    }
  }
  if (retiredIds.length > 0) {
    await params.lessonStore.retire(retiredIds);
  }
  await evaluateLessonSignalTriggers({
    lessonsNode: params.lessonsNode,
    lessonStore: params.lessonStore,
    updatedLessons: surviving,
    emitSignal: params.emitSignal,
    nowIso: params.nowIso,
  });
  return Object.freeze(retiredIds);
}
