import type { EffectMatcherASTNode } from '../ast/domain-ast.types.js';

/**
 * JSON-serializable capability lease persisted on `ContinuationFrame` records in `LedgerStore`.
 *
 * Granted dynamically by `.elevateLeaseWhen()` on interrupt edges or returned by
 * `BranchableScope.getConflictLease()` to unlock protected resources across turns and loop iterations.
 */
export interface LeaseDelta {
  /** Discriminant identifying a serializable capability lease delta. */
  readonly type: 'harness:lease-delta';
  /** Unique identifier of the granted lease delta. */
  readonly id: string;
  /** Effect matcher AST nodes unlocked by this lease delta. */
  readonly grantedMatchers: readonly EffectMatcherASTNode[];
}
