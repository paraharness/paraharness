import type { z } from 'zod';
import type { MaybeBuilder } from '../ast/ast-foundation.types.js';
import type { LessonStoreASTNode, ModelASTNode } from '../ast/domain-ast.types.js';
import { extractAST } from '../ast/extract-ast.js';
import type {
  LessonEmitSignalTrigger,
  LessonsNode,
} from '../ast/lessons-node.js';
import type { PoolNode } from '../ast/pool-node.js';
import type { SignalNode } from '../ast/signal-node.js';
import type { LessonRecord } from '../ports/lesson-record.js';
import type { CreateLessonsBuilderOptions } from './create-lessons-builder-options.js';
import { assertNonEmptyIdentifier, deepFreeze } from './internal/deep-freeze.js';
import {
  createLessonDistillationBuilder,
  createLessonRetirementBuilder,
  createLessonScoringBuilder,
  createLessonSignalTriggerBuilder,
  DEFAULT_LESSON_SCORING,
} from './internal/lessons-sub-builders.js';
import type { LessonDistillationBuilder } from './lesson-distillation-builder.js';
import type { LessonRetirementBuilder } from './lesson-retirement-builder.js';
import type { LessonScoringBuilder } from './lesson-scoring-builder.js';
import type { LessonSignalTriggerBuilder } from './lesson-signal-trigger-builder.js';
import type { LessonsBuilder } from './lessons-builder.js';

/**
 * Creates a fluent `LessonsBuilder` for `H.lessons(id)`.
 *
 * Seeds default empirical scoring parameters from `DEFAULT_LESSON_SCORING` and validates
 * at `.toAST()` compilation time that a backing `LessonStoreASTNode` is bound.
 *
 * @template TIn Actor input type.
 *
 * @param {string}                           id        - Unique identifier of the lessons subsystem.
 * @param {CreateLessonsBuilderOptions<TIn>} [options] - Optional internal copy-on-write state.
 *
 * @returns {LessonsBuilder<TIn>} Frozen `LessonsBuilder` instance.
 */
export function createLessonsBuilder<TIn = unknown>(
  id: string,
  options?: CreateLessonsBuilderOptions<TIn>,
): LessonsBuilder<TIn> {
  assertNonEmptyIdentifier('H.lessons', id);
  const currentScoring = options?.scoring ?? DEFAULT_LESSON_SCORING;
  const currentTriggers = options?.emitSignalTriggers ?? Object.freeze([]);

  return Object.freeze<LessonsBuilder<TIn>>({
    id,
    store(lessonStore: MaybeBuilder<LessonStoreASTNode>): LessonsBuilder<TIn> {
      return createLessonsBuilder<TIn>(id, { ...options, store: extractAST(lessonStore) });
    },
    queryFrom<TNextIn>(
      schema: z.ZodType<TNextIn, z.ZodTypeDef, unknown>,
      mapper: (input: TNextIn) => string,
    ): LessonsBuilder<TNextIn> {
      return createLessonsBuilder<TNextIn>(id, {
        store: options?.store,
        querySchema: schema,
        queryMapper: mapper,
        distillation: options?.distillation,
        scoring: currentScoring,
        retireAfter: options?.retireAfter,
        emitSignalTriggers: currentTriggers,
      });
    },
    distillWith(
      model: MaybeBuilder<ModelASTNode | PoolNode<ModelASTNode>>,
      configure: ($d: LessonDistillationBuilder) => LessonDistillationBuilder,
    ): LessonsBuilder<TIn> {
      const built = configure(createLessonDistillationBuilder(extractAST(model))).build();
      return createLessonsBuilder<TIn>(id, { ...options, distillation: built });
    },
    scoring(
      configure: ($s: LessonScoringBuilder) => LessonScoringBuilder,
    ): LessonsBuilder<TIn> {
      const built = configure(createLessonScoringBuilder(currentScoring)).build();
      return createLessonsBuilder<TIn>(id, { ...options, scoring: built });
    },
    retireAfter(
      configure: ($r: LessonRetirementBuilder) => LessonRetirementBuilder,
    ): LessonsBuilder<TIn> {
      const built = configure(createLessonRetirementBuilder(options?.retireAfter ?? {})).build();
      return createLessonsBuilder<TIn>(id, { ...options, retireAfter: built });
    },
    emitSignalWhen<TPayload>(
      signal: MaybeBuilder<SignalNode<TPayload>>,
      configure: ($t: LessonSignalTriggerBuilder) => LessonSignalTriggerBuilder,
      mapPayload: (lesson: LessonRecord) => TPayload,
    ): LessonsBuilder<TIn> {
      const thresholds = configure(createLessonSignalTriggerBuilder()).build();
      const trigger: LessonEmitSignalTrigger<TPayload> = deepFreeze<
        LessonEmitSignalTrigger<TPayload>
      >({
        signal: extractAST(signal),
        minCleanPasses: thresholds.minCleanPasses,
        maxViolations: thresholds.maxViolations,
        cooldownHours: thresholds.cooldownHours,
        mapPayload,
      });
      return createLessonsBuilder<TIn>(id, {
        ...options,
        emitSignalTriggers: Object.freeze([...currentTriggers, trigger]),
      });
    },
    toAST(): LessonsNode<TIn> {
      if (options?.store === undefined) {
        throw new Error(`Lessons '${id}' is missing required .store(...) configuration.`);
      }
      return deepFreeze<LessonsNode<TIn>>({
        type: 'harness:lessons',
        id,
        store: options.store,
        querySchema: options.querySchema,
        queryMapper: options.queryMapper,
        distillation: options.distillation,
        scoring: currentScoring,
        retireAfter: options.retireAfter,
        emitSignalTriggers: currentTriggers,
      });
    },
  });
}
