import type { LessonRecord } from '@harness-dsl/core';

/**
 * Projects a high-performing `LessonRecord` into a validated `highLeverageLessonSignal` payload (`CODING_SAMPLE.md` §6.5).
 *
 * Narrows `lesson.partition` to `'db' | 'api' | 'web' | undefined` using flat guard clauses without type casts.
 *
 * @param {LessonRecord} lesson - Empirical lesson record that crossed the graduation trigger threshold.
 *
 * @returns {{ readonly lessonId: string; readonly directive: string; readonly partition: 'db' | 'api' | 'web' | undefined; readonly cleanPassCount: number; readonly violatedCount: number }} Signal payload for `highLeverageLessonSignal`.
 */
export function mapHighLeverageLessonSignalPayload(lesson: LessonRecord): {
  readonly lessonId: string;
  readonly directive: string;
  readonly partition: 'db' | 'api' | 'web' | undefined;
  readonly cleanPassCount: number;
  readonly violatedCount: number;
} {
  let partition: 'db' | 'api' | 'web' | undefined = undefined;
  if (lesson.partition === 'db' || lesson.partition === 'api' || lesson.partition === 'web') {
    partition = lesson.partition;
  }
  return {
    lessonId: lesson.id,
    directive: lesson.directive,
    partition,
    cleanPassCount: lesson.totalCleanPasses,
    violatedCount: lesson.totalViolated,
  };
}
