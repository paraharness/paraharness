import type { ReconcileCleanResult } from './reconcile-clean-result.js';
import type { ReconcileConflictResult } from './reconcile-conflict-result.js';

/**
 * Alias for `ReconcileCleanResult` representing a conflict-free 3-way scope reconciliation result.
 *
 * @template TData Scope inspection receipt (`TReceipt`) or sync receipt (`TSync`) type.
 */
export type CleanReconcileResult<TData = unknown> = ReconcileCleanResult<TData>;

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
