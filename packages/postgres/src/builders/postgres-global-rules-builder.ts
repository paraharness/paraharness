import type { AstBuilder, PostgresRulesSourceNode } from '@harness-dsl/core';

/**
 * Fluent builder for a passive `PostgresRulesSourceNode` (`postgres:global-rules`) AST node.
 *
 * Encapsulates a PostgreSQL connection URI and validated table name from which global rule
 * directives are queried and validated against `GlobalRuleSchema` at runtime.
 */
export interface PostgresGlobalRulesBuilder extends AstBuilder<PostgresRulesSourceNode> {
  /**
   * Compiles the builder into a frozen `PostgresRulesSourceNode` AST node.
   *
   * Returns a deeply immutable descriptor with `type: 'postgres:global-rules'`.
   *
   * @returns {PostgresRulesSourceNode} Immutable `postgres:global-rules` source AST node.
   */
  toAST(): PostgresRulesSourceNode;
}
