import type { AstBuilder, PostgresLessonsNode } from '@harness-dsl/core';

/**
 * Fluent builder for a passive `PostgresLessonsNode` (`postgres:lessons`) AST node.
 *
 * Captures the PostgreSQL connection URI or symbolic `EnvRef` for the empirical lesson store
 * without opening any database connections at declaration time.
 */
export interface PostgresLessonsBuilder extends AstBuilder<PostgresLessonsNode> {
  /**
   * Compiles the builder into a frozen `PostgresLessonsNode` AST node.
   *
   * Returns a deeply immutable descriptor with `type: 'postgres:lessons'`.
   *
   * @returns {PostgresLessonsNode} Immutable `postgres:lessons` AST node.
   */
  toAST(): PostgresLessonsNode;
}
