import type { ScopePredicate, ScopedRule } from '../schemas/core-rules.schema.js';
import type { SourceValue } from './ast-foundation.types.js';
import type { ASTNode } from './ast-node.js';
import type { CheckASTNode, SourceASTNode } from './domain-ast.types.js';

/**
 * Source-backed `ScopedRuleNode` variant loaded from a `SourceASTNode<ScopedRule>` (such as `md.frontmatter`).
 *
 * Resolves rule frontmatter and body at run start while allowing code-level `when` or `directive` overrides.
 */
export interface SourcedScopedRuleNode extends ASTNode {
  /** Discriminant identifying a scoped rule AST node. */
  readonly type: 'harness:scoped-rule';
  /** Unique identifier of the scoped rule. */
  readonly id: string;
  /** External source AST node resolving to a `ScopedRule` object. */
  readonly source: SourceASTNode<ScopedRule>;
  /** Optional code-level `when` predicate overriding or augmenting the source's frontmatter predicate. */
  readonly when?: ScopePredicate;
  /** Optional code-level directive overriding the source's directive body. */
  readonly directive?: SourceValue<string>;
  /** Deterministic `beforeStop` checks enforced when this rule is active and scope mutations occur. */
  readonly enforceBeforeStopChecks: readonly CheckASTNode<unknown>[];
}
