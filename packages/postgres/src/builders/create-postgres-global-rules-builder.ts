import type { EnvRef, PostgresRulesSourceNode } from '@harness-dsl/core';
import { assertValidPostgresIdentifier } from '../ddl/internal/resolve-postgres-client.js';
import type { PostgresGlobalRulesBuilder } from './postgres-global-rules-builder.js';
import type { PostgresGlobalRulesOptions } from './postgres-namespace-contract.js';

/**
 * Creates a pure, side-effect-free `PostgresGlobalRulesBuilder` for `postgres.globalRules(uri, options)`.
 *
 * Validates `options.table` against strict SQL identifier rules (`^[A-Za-z_][A-Za-z0-9_]*$`)
 * immediately at declaration time without opening a PostgreSQL connection.
 *
 * @param {string | EnvRef}            uri     - PostgreSQL connection URI or symbolic `H.env(...)` reference.
 * @param {PostgresGlobalRulesOptions} options - Options specifying the target global rules table name.
 *
 * @returns {PostgresGlobalRulesBuilder} Immutable builder for `PostgresRulesSourceNode`.
 *
 * @throws {Error} If `options.table` is not a valid SQL identifier.
 */
export function createPostgresGlobalRulesBuilder(
  uri: string | EnvRef,
  options: PostgresGlobalRulesOptions,
): PostgresGlobalRulesBuilder {
  if (typeof uri === 'string' && uri.trim().length === 0) {
    throw new Error('postgres.globalRules(uri, options) requires a non-empty database URI.');
  }
  assertValidPostgresIdentifier(options.table, 'table');
  const uriLabel = typeof uri === 'string' ? uri : `env:${uri.key}`;
  const sourceId = options.id ?? `postgres:global-rules:${uriLabel}:${options.table}`;
  const tableName = options.table;
  return Object.freeze<PostgresGlobalRulesBuilder>({
    toAST(): PostgresRulesSourceNode {
      return Object.freeze<PostgresRulesSourceNode>({
        type: 'postgres:global-rules',
        id: sourceId,
        uri,
        table: tableName,
      });
    },
  });
}
