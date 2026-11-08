import type { AstBuilder, PostgresTopologyNode } from '@paraharness/core';

/**
 * Fluent builder for a passive `PostgresTopologyNode` (`postgres:topology`) AST node.
 *
 * Captures the PostgreSQL connection URI or symbolic `EnvRef` for the relational CoW topology store
 * without performing any network I/O at builder time.
 */
export interface PostgresTopologyBuilder extends AstBuilder<PostgresTopologyNode> {
  /**
   * Compiles the builder into a frozen `PostgresTopologyNode` AST node.
   *
   * Returns a deeply immutable descriptor with `type: 'postgres:topology'`.
   *
   * @returns {PostgresTopologyNode} Immutable `postgres:topology` AST node.
   */
  toAST(): PostgresTopologyNode;
}
