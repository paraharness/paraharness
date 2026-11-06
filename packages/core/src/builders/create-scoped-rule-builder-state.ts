import type { SourceValue } from '../ast/ast-foundation.types.js';
import type { CheckASTNode, SourceASTNode } from '../ast/domain-ast.types.js';
import type { ScopePredicate, ScopedRule } from '../schemas/core-rules.schema.js';

/**
 * Optional copy-on-write state for `createScopedRuleBuilder`.
 *
 * Holds the optional external rule source, normalized `ScopePredicate`, directive source,
 * and attached `beforeStop` check AST nodes.
 */
export interface CreateScopedRuleBuilderState {
  /** External source AST node when wrapping a frontmatter-loaded rule. */
  readonly source?: SourceASTNode<ScopedRule>;
  /** Configured scope predicate. */
  readonly when?: ScopePredicate;
  /** Configured directive string or source. */
  readonly directive?: SourceValue<string>;
  /** Attached `beforeStop` check AST nodes. */
  readonly enforceBeforeStopChecks?: readonly CheckASTNode<unknown>[];
}
