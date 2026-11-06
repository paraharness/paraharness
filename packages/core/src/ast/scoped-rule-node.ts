import type { ScopePredicate, ScopedRule } from '../schemas/core-rules.schema.js';
import type { SourceValue } from './ast-foundation.types.js';
import type { CheckASTNode, SourceASTNode } from './domain-ast.types.js';

/**
 * Inline `ScopedRuleNode` variant whose `when` predicate and `directive` are declared directly in code.
 */
export type InlineScopedRuleNode = {
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
};

/**
 * Source-backed `ScopedRuleNode` variant loaded from a `SourceASTNode<ScopedRule>` (such as `md.frontmatter`).
 */
export type SourcedScopedRuleNode = {
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
};

/**
 * Passive AST node representing a partition- or effect-scoped rule (`H.scopedRule(...)`).
 */
export type ScopedRuleNode = InlineScopedRuleNode | SourcedScopedRuleNode;
