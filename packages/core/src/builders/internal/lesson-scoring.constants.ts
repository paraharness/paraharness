import type { LessonScoringConfig } from '../../ast/lessons-node.js';

/**
 * Default empirical scoring and recall parameters for `H.lessons(id)` when `.scoring(...)` is omitted.
 */
export const DEFAULT_LESSON_SCORING: LessonScoringConfig = Object.freeze<LessonScoringConfig>({
  slidingWindowInjections: 20,
  partitionMatchBoost: 0.25,
  decayOnPartitionEpochChange: 0.85,
  recall: Object.freeze<{ readonly minScore: number; readonly maxItems: number }>({
    minScore: 0.2,
    maxItems: 5,
  }),
});
