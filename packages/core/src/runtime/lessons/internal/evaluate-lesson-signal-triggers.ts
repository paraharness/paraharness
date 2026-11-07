import type { EvaluateLessonSignalTriggersParams } from '../evaluate-lesson-signal-triggers-params.js';
import { DEFAULT_LESSON_SCORING_WEIGHTS } from '../lesson-scoring.constants.js';

/**
 * Evaluates `.emitSignalWhen()` triggers across updated `LessonRecord` instances (`SPEC.md` §3.4.3).
 *
 * Checks `minCleanPasses`, `maxViolations`, and `cooldownHours` against `signalLastEmittedAt`,
 * persists `markSignalEmitted`, and routes the projected payload to `emitSignal`.
 *
 * @param {EvaluateLessonSignalTriggersParams} params - Signal trigger evaluation parameters.
 *
 * @returns {Promise<readonly string[]>} Emitted `lessonId:signalId` pairs.
 */
export async function evaluateLessonSignalTriggers(
  params: EvaluateLessonSignalTriggersParams,
): Promise<readonly string[]> {
  if (params.lessonsNode.emitSignalTriggers.length === 0) {
    return Object.freeze([]);
  }
  const nowIso = params.nowIso ?? new Date().toISOString();
  const nowMs = Date.parse(nowIso);
  const emittedPairs: string[] = [];
  for (const lesson of params.updatedLessons) {
    for (const trigger of params.lessonsNode.emitSignalTriggers) {
      if (
        lesson.totalCleanPasses < trigger.minCleanPasses ||
        lesson.totalViolated > trigger.maxViolations
      ) {
        continue;
      }
      const lastIso = lesson.signalLastEmittedAt?.[trigger.signal.id];
      const cooldownMs = trigger.cooldownHours * DEFAULT_LESSON_SCORING_WEIGHTS.MS_PER_HOUR;
      if (lastIso !== undefined && nowMs - Date.parse(lastIso) < cooldownMs) {
        continue;
      }
      const payload = trigger.mapPayload(lesson);
      await params.lessonStore.markSignalEmitted(lesson.id, trigger.signal.id, nowIso);
      if (params.emitSignal !== undefined) {
        await params.emitSignal(trigger.signal.id, payload);
      }
      emittedPairs.push(`${lesson.id}:${trigger.signal.id}`);
    }
  }
  return Object.freeze(emittedPairs);
}
