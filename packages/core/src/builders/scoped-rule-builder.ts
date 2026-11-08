import type { MaybeBuilder, MaybeSource } from '../ast/ast-foundation.types.js';
import type { AstBuilder } from '../ast/ast-builder.js';
import type { CheckASTNode } from '../ast/domain-ast.types.js';
import type { ScopedRuleNode } from '../ast/scoped-rule-node.types.js';
import type { ScopePredicateInput } from './scope-predicate-input.js';

/**
 * Fluent builder for partition- or effect-scoped rules (`M.scopedRule(idOrSource)`).
 *
 * Compiles inline or frontmatter-sourced scoped rules with `.when()` activation predicates,
 * `.directive()` prompt blocks, and optional `.enforceBeforeStop()` check gates.
 */
export interface ScopedRuleBuilder extends AstBuilder<ScopedRuleNode> {
  /** Unique identifier of the scoped rule. */
  readonly id: string;

  /**
   * Configures the partition and/or reactive tool-effect predicate triggering rule injection.
   *
   * Rules matching `predicate.partitions` are injected pre-flight at Turn 0; rules matching `predicate.effects` are injected post-call.
   *
   * @param {ScopePredicateInput} predicate - Partition list and optional effect matcher.
   *
   * @returns {ScopedRuleBuilder} New immutable scoped rule builder.
   */
  when(predicate: ScopePredicateInput): ScopedRuleBuilder;

  /**
   * Sets the rule directive text or `SourceASTNode<string>` injected when `when` matches.
   *
   * Normalizes inline strings and source builders into a passive `SourceValue<string>`.
   *
   * @param {MaybeSource<string>} directiveSource - Inline directive string or source node/builder.
   *
   * @returns {ScopedRuleBuilder} New immutable scoped rule builder.
   */
  directive(directiveSource: MaybeSource<string>): ScopedRuleBuilder;

  /**
   * Attaches deterministic `CheckASTNode` gates enforced during `beforeStop` when this rule is active and scope mutations occur.
   *
   * Appends `checks` in declaration order to the rule's `enforceBeforeStopChecks` list.
   *
   * @template THandle Isolation scope handle type.
   *
   * @param {...ReadonlyArray<MaybeBuilder<CheckASTNode<THandle>>>} checks - Deterministic check AST nodes or builders.
   *
   * @returns {ScopedRuleBuilder} New immutable scoped rule builder.
   */
  enforceBeforeStop<THandle = unknown>(
    ...checks: ReadonlyArray<MaybeBuilder<CheckASTNode<THandle>>>
  ): ScopedRuleBuilder;
}
