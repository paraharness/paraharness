import type { z } from 'zod';
import type { MaybeBuilder } from '../ast/ast-foundation.types.js';
import type { AstBuilder } from '../ast/ast-builder.js';
import type { LessonStoreASTNode, ModelASTNode } from '../ast/domain-ast.types.js';
import type { LessonsNode } from '../ast/lessons-node.js';
import type { PoolNode } from '../ast/pool-node.js';
import type { SignalNode } from '../ast/signal-node.js';
import type { LessonRecord } from '../ports/lesson-record.js';
import type { LessonDistillationBuilder } from './lesson-distillation-builder.js';
import type { LessonRetirementBuilder } from './lesson-retirement-builder.js';
import type { LessonScoringBuilder } from './lesson-scoring-builder.js';
import type { LessonSignalTriggerBuilder } from './lesson-signal-trigger-builder.js';

/**
 * Fluent builder for empirical lesson memory subsystems (`P.lessons(id)`).
 *
 * Configures backing store binding, typed recall query extraction, contrastive
 * distillation, 4-state empirical scoring, automatic retirement, and promotion signals.
 *
 * @template TIn Input payload type of actors querying this lesson subsystem.
 */
export interface LessonsBuilder<TIn = unknown> extends AstBuilder<LessonsNode<TIn>> {
  /** Unique identifier of the lessons subsystem. */
  readonly id: string;

  /**
   * Binds the backing `LessonStoreASTNode` (`sqlite.lessonStore` or `postgres.lessonStore`).
   *
   * Required before `.toAST()` can compile a valid `LessonsNode`.
   *
   * @param {MaybeBuilder<LessonStoreASTNode>} lessonStore - Backing lesson store AST node or builder.
   *
   * @returns {LessonsBuilder<TIn>} New immutable lessons builder.
   */
  store(lessonStore: MaybeBuilder<LessonStoreASTNode>): LessonsBuilder<TIn>;

  /**
   * Configures typed search query extraction from the actor's validated input `TNextIn`.
   *
   * Narrows the builder's `TIn` type parameter to `TNextIn` so actors mounting this subsystem are type-checked.
   *
   * @template TNextIn Actor input payload type validated by `schema`.
   *
   * @param {z.ZodType<TNextIn>}         schema - Zod schema for the query input.
   * @param {(input: TNextIn) => string} mapper - Synchronous query string projector.
   *
   * @returns {LessonsBuilder<TNextIn>} New immutable lessons builder narrowed to `TNextIn`.
   */
  queryFrom<TNextIn>(
    schema: z.ZodType<TNextIn>,
    mapper: (input: TNextIn) => string,
  ): LessonsBuilder<TNextIn>;

  /**
   * Configures contrastive lesson distillation with a model or model pool.
   *
   * Invokes `configure` with a fresh `LessonDistillationBuilder` bound to `model`.
   *
   * @param {MaybeBuilder<ModelASTNode | PoolNode<ModelASTNode>>}          model     - Distiller model or pool.
   * @param {($d: LessonDistillationBuilder) => LessonDistillationBuilder} configure - Distillation configurator callback.
   *
   * @returns {LessonsBuilder<TIn>} New immutable lessons builder.
   */
  distillWith(
    model: MaybeBuilder<ModelASTNode | PoolNode<ModelASTNode>>,
    configure: ($d: LessonDistillationBuilder) => LessonDistillationBuilder,
  ): LessonsBuilder<TIn>;

  /**
   * Configures the 4-state empirical scoring and recall formula.
   *
   * Invokes `configure` with a `LessonScoringBuilder` seeded from current or default scoring parameters.
   *
   * @param {($s: LessonScoringBuilder) => LessonScoringBuilder} configure - Scoring configurator callback.
   *
   * @returns {LessonsBuilder<TIn>} New immutable lessons builder.
   */
  scoring(configure: ($s: LessonScoringBuilder) => LessonScoringBuilder): LessonsBuilder<TIn>;

  /**
   * Configures automatic retirement thresholds for violated or low-pass-rate lessons.
   *
   * Invokes `configure` with a `LessonRetirementBuilder` and stores the compiled `LessonRetirementConfig`.
   *
   * @param {($r: LessonRetirementBuilder) => LessonRetirementBuilder} configure - Retirement configurator callback.
   *
   * @returns {LessonsBuilder<TIn>} New immutable lessons builder.
   */
  retireAfter(
    configure: ($r: LessonRetirementBuilder) => LessonRetirementBuilder,
  ): LessonsBuilder<TIn>;

  /**
   * Registers a promotion signal trigger emitted when a lesson crosses high-leverage thresholds.
   *
   * Appends the compiled `LessonEmitSignalTrigger<TPayload>` to `emitSignalTriggers`.
   *
   * @template TPayload Signal payload type validated by `signal.schema`.
   *
   * @param {MaybeBuilder<SignalNode<TPayload>>}                             signal     - Target signal node or builder.
   * @param {($t: LessonSignalTriggerBuilder) => LessonSignalTriggerBuilder} configure  - Trigger threshold configurator.
   * @param {(lesson: LessonRecord) => TPayload}                             mapPayload - Lesson-to-signal payload projector.
   *
   * @returns {LessonsBuilder<TIn>} New immutable lessons builder.
   */
  emitSignalWhen<TPayload>(
    signal: MaybeBuilder<SignalNode<TPayload>>,
    configure: ($t: LessonSignalTriggerBuilder) => LessonSignalTriggerBuilder,
    mapPayload: (lesson: LessonRecord) => TPayload,
  ): LessonsBuilder<TIn>;
}
