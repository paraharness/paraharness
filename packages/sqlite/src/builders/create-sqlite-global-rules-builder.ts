import type { SqliteRulesSourceNode } from '@metaharness/core';
import { assertValidSqlIdentifier } from '../ddl/internal/open-sqlite-connection.js';
import type { SqliteGlobalRulesBuilder } from './sqlite-global-rules-builder.js';
import type { SqliteGlobalRulesOptions } from './sqlite-namespace-contract.js';

/**
 * Creates an immutable `SqliteGlobalRulesBuilder` for `uri` and `options.table`.
 *
 * Validates `options.table` against `^[A-Za-z_][A-Za-z0-9_]*$` at builder construction time
 * to prevent SQL injection when querying global rule rows.
 *
 * @param {string}                   uri     - Host-root-relative SQLite database file path or `:memory:` URI.
 * @param {SqliteGlobalRulesOptions} options - Table name and optional source node ID.
 *
 * @returns {SqliteGlobalRulesBuilder} Frozen SQLite global rules source builder.
 */
export function createSqliteGlobalRulesBuilder(
  uri: string,
  options: SqliteGlobalRulesOptions,
): SqliteGlobalRulesBuilder {
  if (uri.trim().length === 0) {
    throw new Error('sqlite.globalRules(uri, options) requires a non-empty database URI.');
  }
  assertValidSqlIdentifier(options.table, 'table');
  const sourceId = options.id ?? `sqlite:global-rules:${uri}:${options.table}`;
  return Object.freeze<SqliteGlobalRulesBuilder>({
    toAST(): SqliteRulesSourceNode {
      return Object.freeze<SqliteRulesSourceNode>({
        type: 'sqlite:global-rules',
        id: sourceId,
        uri,
        table: options.table,
      });
    },
  });
}
