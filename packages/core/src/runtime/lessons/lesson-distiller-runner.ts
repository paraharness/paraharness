import type {
  EvaluateLessonSignalTriggersParams,
  FlushStepLessonOutcomesParams,
  LessonDistillationParams,
} from './lesson-distillation-params.js';
import { invokeDistillerAndAdmit } from './internal/invoke-distiller-and-admit.js';
import { shouldRetireLesson } from './lesson-scoring.js';
import { DEFAULT_LESSON_SCORING_WEIGHTS } from './lesson-scoring.constants.js';

/**
 * Executes contrastive lesson distillation for an accepted loop or gate recovery pair (`SPEC.md` §3.4.3).
 *
 * Invokes the configured distiller model with `DistilledLessonCandidateSchema`, applies the
 * `admit: boolean` noise filter, and admits reusable lessons with active-overlay `epochAtCreation`
 * and `createdByRunId` attribution.
 *
 * @param {LessonDistillationParams} params - Distillation parameters, stores, and trajectory pair.
 *
 * @returns {Promise<string | undefined>} Admitted lesson ID, or `undefined` when filtered or disabled.
 */
export async function runContrastiveLessonDistillation(
  params: LessonDistillationParams,
): Promise<string | undefined> {
  const dist = params.lessonsNode.distillation;
  if (dist === undefined) return undefined;
  if (params.trajectory.source === 'loop' && !dist.onLoopRecovery) return undefined;
  if (params.trajectory.source === 'gate') {
    if (dist.onGateRecovery === undefined) return undefined;
    const failedCount =
      params.trajectory.rejected.failedChecks?.length ?? params.trajectory.rejected.deficits.length;
    if (failedCount < dist.onGateRecovery.minFailedChecks) return undefined;
  }
  return invokeDistillerAndAdmit(params);
}

/**
 * Flushes deduplicated per-step lesson outcomes to `LessonStore`, retires degraded lessons, and evaluates signal triggers.
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
  const entries: Array<{ readonly lessonId: string; readonly outcome: typeof params.accumulatedOutcomes[string] }> = [];
  for (const [lessonId, outcome] of Object.entries(params.accumulatedOutcomes)) {
    if (outcome !== undefined) entries.push({ lessonId, outcome });
  }
  if (entries.length === 0) return Object.freeze([]);
  const updated = await params.lessonStore.recordOutcomes(entries);
  const retiredIds: string[] = [];
  const surviving = [];
  for (const lesson of updated) {
    if (shouldRetireLesson(lesson, params.lessonsNode.retireAfter, params.lessonsNode.scoring.slidingWindowInjections)) {
      retiredIds.push(lesson.id);
    } else {
      surviving.push(lesson);
    }
  }
  if (retiredIds.length > 0) await params.lessonStore.retire(retiredIds);
  await evaluateLessonSignalTriggers({
    lessonsNode: params.lessonsNode,
    lessonStore: params.lessonStore,
    updatedLessons: surviving,
    emitSignal: params.emitSignal,
    nowIso: params.nowIso,
  });
  return Object.freeze(retiredIds);
}

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
  if (params.lessonsNode.emitSignalTriggers.length === 0) return Object.freeze([]);
  const nowIso = params.nowIso ?? new Date().toISOString();
  const nowMs = Date.parse(nowIso);
  const emittedPairs: string[] = [];
  for (const lesson of params.updatedLessons) {
    for (const trigger of params.lessonsNode.emitSignalTriggers) {
      if (lesson.totalCleanPasses < trigger.minCleanPasses || lesson.totalViolated > trigger.maxViolations) continue;
      const lastIso = lesson.signalLastEmittedAt?.[trigger.signal.id];
      const cooldownMs = trigger.cooldownHours * DEFAULT_LESSON_SCORING_WEIGHTS.MS_PER_HOUR;
      if (lastIso !== undefined && nowMs - Date.parse(lastIso) < cooldownMs) continue;
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
