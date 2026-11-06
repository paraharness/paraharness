import type { MaybeSource } from '../../ast/ast-foundation.types.js';
import type { ModelASTNode } from '../../ast/domain-ast.types.js';
import type {
  LessonDistillationConfig,
  LessonRetirementConfig,
  LessonScoringConfig,
} from '../../ast/lessons-node.js';
import type { PoolNode } from '../../ast/pool-node.js';
import type { LessonDistillationBuilder } from '../lesson-distillation-builder.js';
import type { LessonRetirementBuilder } from '../lesson-retirement-builder.js';
import type { LessonScoringBuilder } from '../lesson-scoring-builder.js';
import type { LessonSignalTriggerBuilder } from '../lesson-signal-trigger-builder.js';
import { deepFreeze } from './deep-freeze.js';
import type { LessonDistillationBuilderState } from './lesson-distillation-builder-state.js';
import { DEFAULT_LESSON_SCORING } from './lesson-scoring.constants.js';
import { normalizeMaybeSource } from './normalize-maybe-source.js';

export { DEFAULT_LESSON_SCORING };
export type { LessonDistillationBuilderState };

/**
 * Creates a fluent `LessonDistillationBuilder` instance.
 *
 * Captures loop recovery triggers, gate recovery failure thresholds, and distillation
 * guidelines for contrastive lesson extraction.
 *
 * @param {ModelASTNode | PoolNode<ModelASTNode>} modelNode - Distiller model or model pool.
 * @param {LessonDistillationBuilderState}        [state]   - Optional distillation builder state.
 *
 * @returns {LessonDistillationBuilder} Frozen distillation configurator.
 */
export function createLessonDistillationBuilder(
  modelNode: ModelASTNode | PoolNode<ModelASTNode>,
  state?: LessonDistillationBuilderState,
): LessonDistillationBuilder {
  return Object.freeze<LessonDistillationBuilder>({
    onLoopRecovery: (enabled = true): LessonDistillationBuilder =>
      createLessonDistillationBuilder(modelNode, { ...state, onLoopRecovery: enabled }),
    onGateRecovery: (opts?: { readonly minFailedChecks?: number }): LessonDistillationBuilder =>
      createLessonDistillationBuilder(modelNode, {
        ...state,
        onGateRecovery: Object.freeze<{ readonly minFailedChecks: number }>({
          minFailedChecks: opts?.minFailedChecks ?? 1,
        }),
      }),
    guidelines: (src: MaybeSource<string>): LessonDistillationBuilder =>
      createLessonDistillationBuilder(modelNode, {
        ...state,
        guidelines: normalizeMaybeSource(src),
      }),
    build: (): LessonDistillationConfig =>
      deepFreeze<LessonDistillationConfig>({
        model: modelNode,
        onLoopRecovery: state?.onLoopRecovery ?? false,
        onGateRecovery: state?.onGateRecovery,
        guidelines: state?.guidelines,
      }),
  });
}

/**
 * Creates a fluent `LessonScoringBuilder` instance.
 *
 * Configures sliding window injection counts, partition match boosts, epoch decay
 * multipliers, and recall filtering thresholds.
 *
 * @param {LessonScoringConfig} cfg - Current lesson scoring configuration.
 *
 * @returns {LessonScoringBuilder} Frozen scoring configurator.
 */
export function createLessonScoringBuilder(cfg: LessonScoringConfig): LessonScoringBuilder {
  return Object.freeze<LessonScoringBuilder>({
    slidingWindowInjections: (slidingWindowInjections: number): LessonScoringBuilder =>
      createLessonScoringBuilder({ ...cfg, slidingWindowInjections }),
    partitionMatchBoost: (partitionMatchBoost: number): LessonScoringBuilder =>
      createLessonScoringBuilder({ ...cfg, partitionMatchBoost }),
    decayOnPartitionEpochChange: (decayOnPartitionEpochChange: number): LessonScoringBuilder =>
      createLessonScoringBuilder({ ...cfg, decayOnPartitionEpochChange }),
    recall: (recall: { readonly minScore: number; readonly maxItems: number }): LessonScoringBuilder =>
      createLessonScoringBuilder({
        ...cfg,
        recall: Object.freeze<{ readonly minScore: number; readonly maxItems: number }>({ ...recall }),
      }),
    build: (): LessonScoringConfig => deepFreeze<LessonScoringConfig>(cfg),
  });
}

/**
 * Creates a fluent `LessonRetirementBuilder` instance.
 *
 * Configures automatic retirement thresholds based on lifetime violation counts
 * or minimum clean pass rates after a warmup window of injections.
 *
 * @param {LessonRetirementConfig} cfg - Current retirement configuration.
 *
 * @returns {LessonRetirementBuilder} Frozen retirement configurator.
 */
export function createLessonRetirementBuilder(
  cfg: LessonRetirementConfig,
): LessonRetirementBuilder {
  return Object.freeze<LessonRetirementBuilder>({
    maxViolations: (maxViolations: number): LessonRetirementBuilder =>
      createLessonRetirementBuilder({ ...cfg, maxViolations }),
    orMinCleanPassRate: (
      minRate: number,
      opts: { readonly afterInjections: number },
    ): LessonRetirementBuilder =>
      createLessonRetirementBuilder({
        ...cfg,
        minCleanPassRate: Object.freeze<{ readonly minRate: number; readonly afterInjections: number }>({
          minRate,
          afterInjections: opts.afterInjections,
        }),
      }),
    build: (): LessonRetirementConfig => deepFreeze<LessonRetirementConfig>(cfg),
  });
}

/**
 * Creates a fluent `LessonSignalTriggerBuilder` instance.
 *
 * Configures promotion signal emission thresholds including minimum clean passes,
 * maximum violations, and cooldown hours between emissions.
 *
 * @param {number} [minCleanPasses=10] - Minimum lifetime clean passes threshold.
 * @param {number} [maxViolations=0]   - Maximum lifetime violations threshold.
 * @param {number} [cooldownHours=72]  - Cooldown window in hours.
 *
 * @returns {LessonSignalTriggerBuilder} Frozen promotion signal trigger configurator.
 */
export function createLessonSignalTriggerBuilder(
  minCleanPasses = 10,
  maxViolations = 0,
  cooldownHours = 72,
): LessonSignalTriggerBuilder {
  return Object.freeze<LessonSignalTriggerBuilder>({
    minCleanPasses: (c: number): LessonSignalTriggerBuilder =>
      createLessonSignalTriggerBuilder(c, maxViolations, cooldownHours),
    maxViolations: (v: number): LessonSignalTriggerBuilder =>
      createLessonSignalTriggerBuilder(minCleanPasses, v, cooldownHours),
    cooldownHours: (h: number): LessonSignalTriggerBuilder =>
      createLessonSignalTriggerBuilder(minCleanPasses, maxViolations, h),
    build: (): {
      readonly minCleanPasses: number;
      readonly maxViolations: number;
      readonly cooldownHours: number;
    } =>
      Object.freeze<{
        readonly minCleanPasses: number;
        readonly maxViolations: number;
        readonly cooldownHours: number;
      }>({ minCleanPasses, maxViolations, cooldownHours }),
  });
}
