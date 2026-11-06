/**
 * Fluent configurator for lesson promotion signal triggers (`$t` in `.emitSignalWhen(sig, $t => ..., mapper)`).
 *
 * Configures the minimum lifetime clean passes, maximum lifetime violations, and cooldown
 * window in hours required before emitting a rule-promotion signal for a high-leverage lesson.
 */
export interface LessonSignalTriggerBuilder {
  /**
   * Sets the minimum lifetime `clean_pass` count required to emit the promotion signal.
   *
   * Lessons must accumulate at least `count` clean passes before becoming eligible for promotion.
   *
   * @param {number} count - Minimum lifetime clean pass count.
   *
   * @returns {LessonSignalTriggerBuilder} New immutable signal trigger builder.
   */
  minCleanPasses(count: number): LessonSignalTriggerBuilder;

  /**
   * Sets the maximum lifetime `violated` count allowed to emit the promotion signal.
   *
   * Lessons with more than `count` lifetime violations are excluded from promotion signal emission.
   *
   * @param {number} count - Maximum allowed lifetime violation count.
   *
   * @returns {LessonSignalTriggerBuilder} New immutable signal trigger builder.
   */
  maxViolations(count: number): LessonSignalTriggerBuilder;

  /**
   * Sets the cooldown window in hours before re-emitting the signal for the same lesson.
   *
   * Prevents duplicate promotion signals from firing repeatedly within `hours` hours.
   *
   * @param {number} hours - Positive cooldown duration in hours.
   *
   * @returns {LessonSignalTriggerBuilder} New immutable signal trigger builder.
   */
  cooldownHours(hours: number): LessonSignalTriggerBuilder;

  /**
   * Compiles and returns the frozen threshold numbers for this promotion trigger.
   *
   * Returns an immutable object containing `minCleanPasses`, `maxViolations`, and `cooldownHours`.
   *
   * @returns {{ readonly minCleanPasses: number; readonly maxViolations: number; readonly cooldownHours: number }} Frozen trigger thresholds.
   */
  build(): {
    readonly minCleanPasses: number;
    readonly maxViolations: number;
    readonly cooldownHours: number;
  };
}
