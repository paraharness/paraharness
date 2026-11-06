import type { MaybeBuilder, MaybeSource } from '../ast/ast-foundation.types.js';
import type { AstBuilder } from '../ast/ast-builder.js';
import type { RulesNode } from '../ast/rules-node.js';
import type { ScopedRuleNode } from '../ast/scoped-rule-node.types.js';
import type { GlobalRule, ScopedRule } from '../schemas/core-rules.schema.js';

/**
 * Fluent builder for rule registries (`H.rules(id)`).
 *
 * Aggregates always-active `GlobalRule` entries (pinned in `[GLOBAL_RULES]`) and
 * partition- or effect-activated `ScopedRuleNode` entries.
 */
export interface RulesBuilder extends AstBuilder<RulesNode> {
  /** Unique identifier of the rules registry. */
  readonly id: string;

  /**
   * Appends inline `GlobalRule` records or external `SourceASTNode<GlobalRule | readonly GlobalRule[]>` sources.
   *
   * Preserves declaration order across all `.global(...)` calls on this registry.
   *
   * @param {...ReadonlyArray<MaybeSource<GlobalRule | readonly GlobalRule[]>>} rules - Global rules or sources.
   *
   * @returns {RulesBuilder} New immutable rules builder.
   */
  global(
    ...rules: ReadonlyArray<MaybeSource<GlobalRule | readonly GlobalRule[]>>
  ): RulesBuilder;

  /**
   * Appends `ScopedRuleNode` builders/nodes or external `SourceASTNode<ScopedRule | readonly ScopedRule[]>` sources.
   *
   * Extracts `.toAST()` from any `ScopedRuleBuilder` or source builder arguments.
   *
   * @param {...ReadonlyArray<MaybeBuilder<ScopedRuleNode> | MaybeSource<ScopedRule | readonly ScopedRule[]>>} rules - Scoped rules or sources.
   *
   * @returns {RulesBuilder} New immutable rules builder.
   */
  scoped(
    ...rules: ReadonlyArray<
      MaybeBuilder<ScopedRuleNode> | MaybeSource<ScopedRule | readonly ScopedRule[]>
    >
  ): RulesBuilder;
}
