import type { SqliteLessonsNode } from '@paraharness/core';
import type { SqliteLessonsBuilder } from './sqlite-lessons-builder.js';

/**
 * Creates an immutable `SqliteLessonsBuilder` targeting `uri`.
 *
 * Validates that `uri` is non-empty and emits a frozen `SqliteLessonsNode` AST node on `.toAST()`.
 *
 * @param {string} uri - Host-root-relative SQLite database file path or `:memory:` URI.
 *
 * @returns {SqliteLessonsBuilder} Frozen SQLite lesson store builder.
 */
export function createSqliteLessonsBuilder(uri: string): SqliteLessonsBuilder {
  if (uri.trim().length === 0) {
    throw new Error('sqlite.lessonStore(uri) requires a non-empty database URI.');
  }
  return Object.freeze<SqliteLessonsBuilder>({
    toAST(): SqliteLessonsNode {
      return Object.freeze<SqliteLessonsNode>({
        type: 'sqlite:lessons',
        uri,
      });
    },
  });
}
