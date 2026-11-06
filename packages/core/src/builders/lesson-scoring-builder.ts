import type { LessonScoringConfig } from '../ast/lessons-node.js';

/**
 * Fluent configurator for lesson scoring and recall parameters (`$s` in `.scoring($s => ...)`).
 *
 * Configures the sliding-window injection count $K$, partition match boost $\beta$,
 * epoch decay factor $\gamma$, and recall filtering bounds (`minScore` and `maxItems`).
 */
export interface LessonScoringBuilder {
  /**
   * Sets the sliding window size $K$ of deduplicated step executions used for utility scoring.
   *
   * Determines how many recent injections are evaluated when computing a lesson's empirical pass rate.
   *
   * @param {number} count - Positive integer sliding window size $K$.
   *
   * @returns {LessonScoringBuilder} New immutable scoring builder.
   */
  slidingWindowInjections(count: number): LessonScoringBuilder;

  /**
   * Sets the partition match boost factor $\beta$ applied when a lesson's partitions overlap active partitions.
   *
   * Increases the composite recall score of partition-specific lessons relative to generic lessons.
   *
   * @param {number} boost - Non-negative partition match boost factor $\beta$.
   *
   * @returns {LessonScoringBuilder} New immutable scoring builder.
   */
  partitionMatchBoost(boost: number): LessonScoringBuilder;

  /**
   * Sets the exponential decay factor $\gamma \in (0, 1]$ per partition contract epoch increment.
   *
   * Attenuates older lessons when the topology contract of their associated partition evolves.
   *
   * @param {number} decay - Decay multiplier $\gamma \in (0, 1]$.
   *
   * @returns {LessonScoringBuilder} New immutable scoring builder.
   */
  decayOnPartitionEpochChange(decay: number): LessonScoringBuilder;

  /**
   * Sets the recall filter thresholds (`minScore` and `maxItems`) applied at Turn 0.
   *
   * Only lessons scoring at least `opts.minScore` up to `opts.maxItems` are injected into context.
   *
   * @param {{ readonly minScore: number; readonly maxItems: number }} opts - Recall filter bounds.
   *
   * @returns {LessonScoringBuilder} New immutable scoring builder.
   */
  recall(opts: { readonly minScore: number; readonly maxItems: number }): LessonScoringBuilder;

  /**
   * Compiles and returns the frozen `LessonScoringConfig`.
   *
   * Freezes all scoring parameters and nested recall bounds into a passive AST record.
   *
   * @returns {LessonScoringConfig} Deeply frozen scoring configuration.
   */
  build(): LessonScoringConfig;
}
