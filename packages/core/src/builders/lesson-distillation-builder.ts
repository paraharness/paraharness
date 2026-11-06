import type { MaybeSource } from '../ast/ast-foundation.types.js';
import type { LessonDistillationConfig } from '../ast/lessons-node.js';

/**
 * Fluent configurator for contrastive lesson distillation (`$d` in `.distillWith(model, $d => ...)`).
 *
 * Captures loop recovery triggers, `beforeStop` gate recovery thresholds, and distillation
 * guidelines used when extracting empirical lessons from failure-to-pass trajectories.
 */
export interface LessonDistillationBuilder {
  /**
   * Enables or disables contrastive distillation on outer `H.loop` recovery iterations.
   *
   * Pairs the most recent rejected `.act()` trajectory with the subsequent accepted iteration trajectory.
   *
   * @param {boolean} [enabled=true] - Whether outer loop recovery distillation is active.
   *
   * @returns {LessonDistillationBuilder} New immutable distillation builder.
   */
  onLoopRecovery(enabled?: boolean): LessonDistillationBuilder;

  /**
   * Enables contrastive distillation on in-session `beforeStop` gate recoveries.
   *
   * Triggers distillation when an agent fails at least `minFailedChecks` before subsequently passing `beforeStop`.
   *
   * @param {{ readonly minFailedChecks?: number }} [opts] - Minimum failed check threshold options.
   *
   * @returns {LessonDistillationBuilder} New immutable distillation builder.
   */
  onGateRecovery(opts?: { readonly minFailedChecks?: number }): LessonDistillationBuilder;

  /**
   * Binds distillation guidelines text or external `SourceASTNode<string>`.
   *
   * Injected into the distiller model's prompt when extracting candidate lessons.
   *
   * @param {MaybeSource<string>} source - Inline guidelines string or source AST node.
   *
   * @returns {LessonDistillationBuilder} New immutable distillation builder.
   */
  guidelines(source: MaybeSource<string>): LessonDistillationBuilder;

  /**
   * Compiles and returns the frozen `LessonDistillationConfig`.
   *
   * Finalizes the distiller model, recovery triggers, and guidelines into a passive AST record.
   *
   * @returns {LessonDistillationConfig} Deeply frozen distillation configuration.
   */
  build(): LessonDistillationConfig;
}
