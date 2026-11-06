import type { LessonsNode } from '../../ast/lessons-node.js';
import type { LessonOutcome } from '../../ports/lesson-outcome.types.js';
import type { LessonStore } from '../../ports/lesson-store.js';

/**
 * Parameters for flushing deduplicated step or loop lesson outcomes to `LessonStore`.
 *
 * Consolidates the `LessonsNode`, `LessonStore`, deduplicated outcome map, retirement evaluation,
 * and promotion signal routing.
 */
export interface FlushStepLessonOutcomesParams {
  /** Passive `LessonsNode` governing scoring, retirement, and promotion signals. */
  readonly lessonsNode: LessonsNode<unknown>;
  /** Runtime `LessonStore` receiving `recordOutcomes` and `retire` calls. */
  readonly lessonStore: LessonStore;
  /** Deduplicated `lessonId -> LessonOutcome` map accumulated across the step or loop. */
  readonly accumulatedOutcomes: Readonly<Record<string, LessonOutcome>>;
  /** Optional callback routing emitted promotion signals into the harness controller. */
  readonly emitSignal?: <TPayload>(signalId: string, payload: TPayload) => Promise<void>;
  /** Optional ISO-8601 timestamp override for deterministic cooldown testing. */
  readonly nowIso?: string;
}
