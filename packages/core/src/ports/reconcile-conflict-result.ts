/**
 * Conflicted 3-way scope reconciliation result returned when concurrent changes overlap.
 *
 * Materializes the conflict inside the target scope handle without polluting `parentHandle`.
 *
 * @template TData Scope inspection receipt (`TReceipt`) or sync receipt (`TSync`) type.
 */
export interface ReconcileConflictResult<TData = unknown> {
  /** Discriminant indicating that 3-way reconciliation encountered conflicts. */
  readonly status: 'conflict';
  /** Diagnostic summary of conflicted paths or resources injected into `[COMMIT_CONFLICT]` or sync notes. */
  readonly conflictedSummary: string;
  /** Validated receipt payload describing the conflict-materialized scope state. */
  readonly data: TData;
}
