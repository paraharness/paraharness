/**
 * Structured output candidate produced by a contrastive lesson distillation model turn.
 *
 * Filters out one-off typos (`admit: false`) before admitting reusable architectural invariants
 * into `LessonStore`.
 */
export interface DistilledLessonCandidate {
  /** Whether the recovery represents a generalizable lesson worth persisting. */
  readonly admit: boolean;
  /** Optional logical partition identifier to scope the lesson. */
  readonly partition?: string;
  /** Concise preventative directive text when `admit === true`. */
  readonly directive?: string;
}
