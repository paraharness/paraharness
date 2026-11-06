import type { z } from 'zod';
import type { LessonStoreASTNode } from '../ast/domain-ast.types.js';
import type {
  LessonDistillationConfig,
  LessonEmitSignalTrigger,
  LessonRetirementConfig,
  LessonScoringConfig,
} from '../ast/lessons-node.js';

/**
 * Optional copy-on-write state for `createLessonsBuilder`.
 *
 * Holds the backing lesson store, optional query schema/mapper, distillation config,
 * scoring config, retirement config, and registered promotion signal triggers.
 *
 * @template TIn Actor input type.
 */
export interface CreateLessonsBuilderOptions<TIn = unknown> {
  /** Backing lesson store AST node. */
  readonly store?: LessonStoreASTNode;
  /** Optional query input Zod schema. */
  readonly querySchema?: z.ZodType<TIn, z.ZodTypeDef, unknown>;
  /** Optional query string mapper. */
  readonly queryMapper?: (input: TIn) => string;
  /** Optional distillation configuration. */
  readonly distillation?: LessonDistillationConfig;
  /** Scoring configuration. */
  readonly scoring?: LessonScoringConfig;
  /** Optional retirement configuration. */
  readonly retireAfter?: LessonRetirementConfig;
  /** Registered promotion signal triggers. */
  readonly emitSignalTriggers?: readonly LessonEmitSignalTrigger[];
}
