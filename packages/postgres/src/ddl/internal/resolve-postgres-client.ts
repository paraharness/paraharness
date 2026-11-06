import type { EnvRef } from '@harness-dsl/core';
import type { PostgresPoolFactory } from '../postgres-pool-factory.js';
import type { PostgresQueryClient } from '../postgres-query-client.js';
import type { PostgresQueryResult } from '../postgres-query-result.js';
import {
  POSTGRES_DDL_STATEMENTS,
  POSTGRES_IDENTIFIER_REGEX,
} from '../postgres-schema.constants.js';

/**
 * Validates that `identifier` matches `^[A-Za-z_][A-Za-z0-9_]*$`.
 *
 * Rejects empty strings or SQL identifiers containing spaces, quotes, punctuation, or comment tokens.
 *
 * @param {string} identifier - Candidate SQL table or column identifier.
 * @param {string} fieldName  - Diagnostic field label included in thrown errors.
 *
 * @returns {void} Returns nothing when `identifier` is valid.
 */
export function assertValidPostgresIdentifier(identifier: string, fieldName: string): void {
  if (!POSTGRES_IDENTIFIER_REGEX.test(identifier)) {
    throw new Error(
      `Invalid PostgreSQL identifier for '${fieldName}': '${identifier}'. Expected matching /^[A-Za-z_][A-Za-z0-9_]*$/.`,
    );
  }
}

/**
 * Applies all idempotent `POSTGRES_DDL_STATEMENTS` to `client`.
 *
 * Ensures ledger, topology overlay, and lesson store tables exist before running queries.
 *
 * @param {PostgresQueryClient} client - Active PostgreSQL query client.
 *
 * @returns {Promise<PostgresQueryClient>} The initialized `PostgresQueryClient`.
 */
export async function ensurePostgresSchemaInitialized(
  client: PostgresQueryClient,
): Promise<PostgresQueryClient> {
  for (const ddlSql of POSTGRES_DDL_STATEMENTS) {
    await client.query(ddlSql);
  }
  return client;
}

/**
 * Resolves a literal connection URI or symbolic `EnvRef` via `resolveEnv` and returns a `PostgresQueryClient`
 * bound to `poolOrClient`.
 *
 * Validates that the resolved URI is non-empty and delegates asynchronous pool acquisition lazily inside `query()`.
 *
 * @param {string | EnvRef}                                uri          - Literal PostgreSQL URI or symbolic `EnvRef`.
 * @param {(value: string | EnvRef) => string | undefined} resolveEnv   - Late-bound environment resolver from runtime context.
 * @param {PostgresPoolFactory | PostgresQueryClient}      poolOrClient - Pool factory or pre-bound query client.
 *
 * @returns {PostgresQueryClient} Bound PostgreSQL query client.
 */
export function resolvePostgresClient(
  uri: string | EnvRef,
  resolveEnv: (value: string | EnvRef) => string | undefined,
  poolOrClient: PostgresPoolFactory | PostgresQueryClient,
): PostgresQueryClient {
  const resolvedUri = resolveEnv(uri) ?? (typeof uri === 'string' ? uri : undefined);
  if (resolvedUri === undefined || resolvedUri.trim().length === 0) {
    const label = typeof uri === 'string' ? uri : `H.env('${uri.key}')`;
    throw new Error(
      `Cannot resolve PostgreSQL connection URI for '${label}': environment variable or URI is empty.`,
    );
  }
  if (!('getClient' in poolOrClient)) {
    return poolOrClient;
  }
  const maybeClient = poolOrClient.getClient(resolvedUri);
  if (!('then' in maybeClient)) {
    return maybeClient;
  }
  return Object.freeze<PostgresQueryClient>({
    async query<TRow = Record<string, unknown>>(
      sql: string,
      params?: readonly unknown[],
    ): Promise<PostgresQueryResult<TRow>> {
      const client = await maybeClient;
      return client.query<TRow>(sql, params);
    },
    async close(): Promise<void> {
      const client = await maybeClient;
      await client.close?.();
    },
  });
}

/**
 * Executes `work` inside a `BEGIN` / `COMMIT` / `ROLLBACK` transaction on `client`.
 *
 * Guarantees that any thrown error rolls back uncommitted mutations before rethrowing.
 *
 * @template TResult Return value type of `work`.
 *
 * @param {PostgresQueryClient}    client - Active PostgreSQL query client.
 * @param {() => Promise<TResult>} work   - Transactional callback to execute.
 *
 * @returns {Promise<TResult>} Result produced by `work` after `COMMIT`.
 */
export async function runInPostgresTransaction<TResult>(
  client: PostgresQueryClient,
  work: () => Promise<TResult>,
): Promise<TResult> {
  await client.query('BEGIN');
  try {
    const result = await work();
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}
