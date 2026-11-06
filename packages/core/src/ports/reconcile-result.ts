/**
 * Clean 3-way scope reconciliation result returned by `commitChild`, `syncChild`, or `syncRoot`.
 *
 * Indicates that the child or root scope reconciled cleanly without overlapping edits.
 *
 * @template TData Scope inspection receipt (`TReceipt`) or sync receipt (`TSync`) type.
 */
export type ReconcileCleanResult<TData = unknown> = {
  /** Discriminant indicating a conflict-free 3-way reconciliation. */
  readonly status: 'clean';
  /** Validated receipt payload describing the reconciled scope state. */
  readonly data: TData;
};

/**
 * Alias for `ReconcileCleanResult` representing a conflict-free 3-way scope reconciliation result.
 *
 * @template TData Scope inspection receipt (`TReceipt`) or sync receipt (`TSync`) type.
 */
export type CleanReconcileResult<TData = unknown> = ReconcileCleanResult<TData>;

/**
 * Conflicted 3-way scope reconciliation result returned when concurrent changes overlap.
 *
 * Materializes the conflict inside the target scope handle without polluting `parentHandle`.
 *
 * @template TData Scope inspection receipt (`TReceipt`) or sync receipt (`TSync`) type.
 */
export type ReconcileConflictResult<TData = unknown> = {
  /** Discriminant indicating that 3-way reconciliation encountered conflicts. */
  readonly status: 'conflict';
  /** Diagnostic summary of conflicted paths or resources injected into `[COMMIT_CONFLICT]` or sync notes. */
  readonly conflictedSummary: string;
  /** Validated receipt payload describing the conflict-materialized scope state. */
  readonly data: TData;
};

/**
 * Alias for `ReconcileConflictResult` representing a conflicted 3-way scope reconciliation result.
 *
 * @template TData Scope inspection receipt (`TReceipt`) or sync receipt (`TSync`) type.
 */
export type ConflictReconcileResult<TData = unknown> = ReconcileConflictResult<TData>;

/**
 * Discriminated union outcome of `BranchableScope.commitChild`, `syncChild`, and `syncRoot`.
 *
 * @template TData Scope inspection receipt (`TReceipt`) or sync receipt (`TSync`) type.
 */
export type ReconcileResult<TData = unknown> =
  | ReconcileCleanResult<TData>
  | ReconcileConflictResult<TData>;
