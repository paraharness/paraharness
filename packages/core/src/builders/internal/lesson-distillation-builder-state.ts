import type { SourceValue } from '../../ast/ast-foundation.types.js';

/**
 * Immutable copy-on-write state snapshot backing `LessonDistillationBuilder`.
 *
 * Tracks whether outer loop recovery and in-session `beforeStop` gate recovery
 * distillation triggers are active alongside optional distillation guidelines.
 */
export interface LessonDistillationBuilderState {
  /** Whether contrastive distillation is enabled on outer `P.loop` recovery iterations. */
  readonly onLoopRecovery?: boolean;
  /** Optional minimum failed check threshold for in-session `beforeStop` gate recovery distillation. */
  readonly onGateRecovery?: { readonly minFailedChecks: number };
  /** Optional distillation guidelines text or `SourceASTNode<string>`. */
  readonly guidelines?: SourceValue<string>;
}
