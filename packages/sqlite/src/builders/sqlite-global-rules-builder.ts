import type { AstBuilder, SqliteRulesSourceNode } from '@paraharness/core';

/**
 * Fluent builder for a passive `SqliteRulesSourceNode` (`sqlite.globalRules(uri, { table })`).
 *
 * Emits a declarative source descriptor that loads ordered `(id, directive)` global rules from SQLite.
 */
export interface SqliteGlobalRulesBuilder extends AstBuilder<SqliteRulesSourceNode> {
  /**
   * Compiles the builder into an immutable `SqliteRulesSourceNode` AST descriptor.
   *
   * Preserves the validated SQLite URI and table identifier for runtime source execution.
   *
   * @returns {SqliteRulesSourceNode} Frozen passive `SqliteRulesSourceNode`.
   */
  toAST(): SqliteRulesSourceNode;
}
