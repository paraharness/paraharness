import type { SqliteTopologyNode } from '@paraharness/core';
import type { SqliteTopologyBuilder } from './sqlite-topology-builder.js';

/**
 * Creates an immutable `SqliteTopologyBuilder` targeting `uri`.
 *
 * Validates that `uri` is non-empty and emits a frozen `SqliteTopologyNode` AST node on `.toAST()`.
 *
 * @param {string} uri - Host-root-relative SQLite database file path or `:memory:` URI.
 *
 * @returns {SqliteTopologyBuilder} Frozen SQLite topology store builder.
 */
export function createSqliteTopologyBuilder(uri: string): SqliteTopologyBuilder {
  if (uri.trim().length === 0) {
    throw new Error('sqlite.topologyStore(uri) requires a non-empty database URI.');
  }
  return Object.freeze<SqliteTopologyBuilder>({
    toAST(): SqliteTopologyNode {
      return Object.freeze<SqliteTopologyNode>({
        type: 'sqlite:topology',
        uri,
      });
    },
  });
}
