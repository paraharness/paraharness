import type { ScopePredicate } from '../schemas/core-rules.schema.js';
import type { SourceValue } from './ast-foundation.types.js';
import type { ASTNode } from './ast-node.js';
import type { CheckASTNode } from './domain-ast.types.js';

/**
 * Inline `ScopedRuleNode` variant whose `when` predicate and `directive` are declared directly in code.
 *
 * Evaluates `when` against active partitions and observed tool effects and enforces `enforceBeforeStopChecks`.
 */
export interface InlineScopedRuleNode extends ASTNode {
  /** Discriminant identifying a scoped rule AST node. */
  readonly type: 'harness:scoped-rule';
  /** Unique identifier of the scoped rule. */
  readonly id: string;
  /** Undefined on inline scoped rules. */
  readonly source?: undefined;
  /** Scope predicate (`partitions` and optional reactive `effects` matcher) triggering rule injection. */
  readonly when: ScopePredicate;
  /** Rule directive text or `SourceASTNode<string>` injected when `when` matches. */
  readonly directive: SourceValue<string>;
  /** Deterministic `beforeStop` checks enforced when this rule is active and scope mutations occur. */
  readonly enforceBeforeStopChecks: readonly CheckASTNode<unknown>[];
}
