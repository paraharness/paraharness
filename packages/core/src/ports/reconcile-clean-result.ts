/**
 * Clean 3-way scope reconciliation result returned by `commitChild`, `syncChild`, or `syncRoot`.
 *
 * Indicates that the child or root scope reconciled cleanly without overlapping edits.
 *
 * @template TData Scope inspection receipt (`TReceipt`) or sync receipt (`TSync`) type.
 */
export interface ReconcileCleanResult<TData = unknown> {
  /** Discriminant indicating a conflict-free 3-way reconciliation. */
  readonly status: 'clean';
  /** Validated receipt payload describing the reconciled scope state. */
  readonly data: TData;
}
