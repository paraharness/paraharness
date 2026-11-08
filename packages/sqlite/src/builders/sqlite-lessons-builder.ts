import type { AstBuilder, SqliteLessonsNode } from '@paraharness/core';

/**
 * Fluent builder for a passive `SqliteLessonsNode` (`sqlite.lessonStore(uri)`).
 *
 * Produces a declarative lesson store descriptor backed by a WAL-mode SQLite database
 * with zero I/O at AST construction time.
 */
export interface SqliteLessonsBuilder extends AstBuilder<SqliteLessonsNode> {
  /**
   * Compiles the builder into an immutable `SqliteLessonsNode` AST descriptor.
   *
   * Preserves the configured SQLite database URI for runtime driver resolution.
   *
   * @returns {SqliteLessonsNode} Frozen passive `SqliteLessonsNode`.
   */
  toAST(): SqliteLessonsNode;
}
