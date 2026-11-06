import type { LessonsNode } from '../../ast/lessons-node.js';
import type { LessonRecord } from '../../ports/lesson-record.js';
import type { LessonStore } from '../../ports/lesson-store.js';

/**
 * Parameters for evaluating `.emitSignalWhen()` triggers on updated `LessonRecord` entries.
 *
 * Supplies the `LessonsNode`, backing `LessonStore`, updated lesson records, signal emitter,
 * and optional deterministic timestamp override.
 */
export interface EvaluateLessonSignalTriggersParams {
  /** Passive `LessonsNode` declaring `emitSignalTriggers`. */
  readonly lessonsNode: LessonsNode<unknown>;
  /** Runtime `LessonStore` persisting `markSignalEmitted` timestamps. */
  readonly lessonStore: LessonStore;
  /** Updated `LessonRecord` instances returned by `LessonStore.recordOutcomes()`. */
  readonly updatedLessons: readonly LessonRecord[];
  /** Callback routing emitted promotion signals into the harness controller. */
  readonly emitSignal?: <TPayload>(signalId: string, payload: TPayload) => Promise<void>;
  /** Optional ISO-8601 timestamp override for deterministic cooldown testing. */
  readonly nowIso?: string;
}
