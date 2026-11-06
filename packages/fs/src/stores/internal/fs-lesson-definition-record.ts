/**
 * Immutable JSON record persisted in `<definitionsDir>/<lessonId>.json` (`SPEC.md` §4.3).
 *
 * Written once during `FsJsonlLessonStore.admit()` and never mutated on subsequent
 * outcome recordings or epoch synchronizations.
 */
export interface FsLessonDefinitionRecord {
  /** Content-addressed lesson identifier. */
  readonly id: string;
  /** Optional topology partition associated with the lesson. */
  readonly partition?: string;
  /** Preventative or prescriptive directive text. */
  readonly directive: string;
  /** Initial partition contract epoch when the lesson was admitted. */
  readonly epochAtCreation: number;
  /** Optional run identifier that created the lesson or last mutated its partition contract. */
  readonly createdByRunId?: string;
}
