import type { LessonRetirementConfig } from '../ast/lessons-node.js';

/**
 * Fluent configurator for automatic lesson retirement thresholds (`$r` in `.retireAfter($r => ...)`).
 *
 * Configures immediate retirement on lifetime violation count ceilings or low sliding-window
 * clean-pass rates after a minimum number of injections.
 */
export interface LessonRetirementBuilder {
  /**
   * Sets the maximum lifetime violation count $v$ before immediate retirement.
   *
   * Any lesson whose cumulative `violated` count reaches `count` is retired from future recall.
   *
   * @param {number} count - Maximum allowed lifetime violation count.
   *
   * @returns {LessonRetirementBuilder} New immutable retirement builder.
   */
  maxViolations(count: number): LessonRetirementBuilder;

  /**
   * Sets the minimum sliding-window clean-pass rate threshold after `opts.afterInjections` injections.
   *
   * Retires lessons whose clean-pass rate falls below `minRate` once at least `opts.afterInjections` have occurred.
   *
   * @param {number}                               minRate - Minimum clean-pass rate in $[0, 1]$.
   * @param {{ readonly afterInjections: number }} opts    - Warmup injection count before evaluating `minRate`.
   *
   * @returns {LessonRetirementBuilder} New immutable retirement builder.
   */
  orMinCleanPassRate(
    minRate: number,
    opts: { readonly afterInjections: number },
  ): LessonRetirementBuilder;

  /**
   * Compiles and returns the frozen `LessonRetirementConfig`.
   *
   * Freezes the configured violation ceiling and clean-pass rate threshold into a passive AST record.
   *
   * @returns {LessonRetirementConfig} Deeply frozen retirement configuration.
   */
  build(): LessonRetirementConfig;
}
