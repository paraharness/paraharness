import type { MaybeBuilder } from '../ast/ast-foundation.types.js';
import type { EffectMatcherASTNode } from '../ast/domain-ast.types.js';

/**
 * Input predicate shape accepted by `P.scopedRule(...).when(...)` and `P.skill(...).when(...)`.
 *
 * Combines optional pre-flight partition globs with an optional reactive post-call
 * `EffectMatcherASTNode` predicate.
 */
export interface ScopePredicateInput {
  /** Optional list of partition identifiers triggering pre-flight injection. */
  readonly partitions?: readonly string[];
  /** Optional reactive effect matcher AST node or builder triggering post-call injection. */
  readonly effects?: MaybeBuilder<EffectMatcherASTNode>;
}
