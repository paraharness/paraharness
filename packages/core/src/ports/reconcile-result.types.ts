import type { ReconcileCleanResult } from './reconcile-clean-result.js';
import type { ReconcileConflictResult } from './reconcile-conflict-result.js';

export type { ReconcileCleanResult } from './reconcile-clean-result.js';
export type { ReconcileConflictResult } from './reconcile-conflict-result.js';

/**
 * Discriminated union outcome of `BranchableScope.commitChild`, `syncChild`, and `syncRoot`.
 *
 * @template TData Scope inspection receipt (`TReceipt`) or sync receipt (`TSync`) type.
 */
export type ReconcileResult<TData = unknown> =
  | ReconcileCleanResult<TData>
  | ReconcileConflictResult<TData>;
