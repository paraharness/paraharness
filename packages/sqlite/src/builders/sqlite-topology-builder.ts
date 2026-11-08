import type { AstBuilder, SqliteTopologyNode } from '@paraharness/core';

/**
 * Fluent builder for a passive `SqliteTopologyNode` (`sqlite.topologyStore(uri)`).
 *
 * Produces a declarative topology store descriptor backed by a WAL-mode SQLite database
 * with zero I/O at AST construction time.
 */
export interface SqliteTopologyBuilder extends AstBuilder<SqliteTopologyNode> {
  /**
   * Compiles the builder into an immutable `SqliteTopologyNode` AST descriptor.
   *
   * Preserves the configured SQLite database URI for runtime driver resolution.
   *
   * @returns {SqliteTopologyNode} Frozen passive `SqliteTopologyNode`.
   */
  toAST(): SqliteTopologyNode;
}
