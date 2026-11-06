/**
 * Partition epoch and run attribution resolved for a newly distilled lesson (`SPEC.md` §3.4.3).
 *
 * Supplies `epochAtCreation` and `createdByRunId` from the active `TopologyStore` run overlay.
 */
export interface LessonCreationEpochMetadata {
  /** Partition contract epoch active when the lesson was created. */
  readonly epochAtCreation: number;
  /** Run identifier that last mutated the partition overlay, or the current `runId`. */
  readonly createdByRunId: string | undefined;
}
