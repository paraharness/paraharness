import type { EnvRef } from '@harness-dsl/core';
import PQueue from 'p-queue';
import { Pool } from 'pg';
import type { PostgresPoolFactory } from '../postgres-pool-factory.js';
import type { PostgresQueryClient } from '../postgres-query-client.js';
import {
  POSTGRES_DDL_STATEMENTS,
  POSTGRES_IDENTIFIER_REGEX,
  POSTGRES_TRANSACTION_QUEUES,
} from '../postgres-schema.constants.js';
import {
  adaptPgPoolToQueryClient,
  normalizePostgresClient,
  wrapAsyncPostgresClient,
} from './normalize-postgres-client.js';

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
 * bound to `poolOrClient` or a `pg.Pool` (`new Pool({ connectionString })`).
 *
 * Validates that the resolved URI is non-empty and supports `PostgresPoolFactory`, `PostgresQueryClient`, or `pg.Pool`.
 *
 * @param {string | EnvRef}                                     uri            - Literal PostgreSQL URI or symbolic `EnvRef`.
 * @param {(value: string | EnvRef) => string | undefined}      resolveEnv     - Late-bound environment resolver from runtime context.
 * @param {PostgresPoolFactory | PostgresQueryClient | Pool}    [poolOrClient] - Optional pool factory, query client, or `pg.Pool`.
 *
 * @returns {PostgresQueryClient} Bound PostgreSQL query client.
 */
export function resolvePostgresClient(
  uri: string | EnvRef,
  resolveEnv: (value: string | EnvRef) => string | undefined,
  poolOrClient?: PostgresPoolFactory | PostgresQueryClient | Pool,
): PostgresQueryClient {
  const resolvedUri = resolveEnv(uri) ?? (typeof uri === 'string' ? uri : undefined);
  if (resolvedUri === undefined || resolvedUri.trim().length === 0) {
    const label = typeof uri === 'string' ? uri : `H.env('${uri.key}')`;
    throw new Error(
      `Cannot resolve PostgreSQL connection URI for '${label}': environment variable or URI is empty.`,
    );
  }
  if (poolOrClient === undefined) {
    return normalizePostgresClient(resolvedUri);
  }
  if (poolOrClient instanceof Pool) {
    return adaptPgPoolToQueryClient(poolOrClient);
  }
  if (!('getClient' in poolOrClient)) {
    return poolOrClient;
  }
  const maybeClient = poolOrClient.getClient(resolvedUri);
  if (!('then' in maybeClient)) {
    return maybeClient;
  }
  return wrapAsyncPostgresClient(maybeClient);
}

/**
 * Executes `work` inside a serialized `BEGIN` / `COMMIT` / `ROLLBACK` transaction on `client`.
 *
 * Serializes concurrent transactions per `PostgresQueryClient` via `PQueue({ concurrency: 1 })` and pins a dedicated
 * connection via `client.connect()` (releasing it in `finally`) when backed by a connection pool (`pg.Pool`).
 *
 * @template TResult Return value type of `work`.
 *
 * @param {PostgresQueryClient}                                 client - Active PostgreSQL query client or pool adapter.
 * @param {(txClient: PostgresQueryClient) => Promise<TResult>} work   - Transactional callback receiving the pinned transaction client.
 *
 * @returns {Promise<TResult>} Result produced by `work` after `COMMIT`.
 */
export function runInPostgresTransaction<TResult>(
  client: PostgresQueryClient,
  work: (txClient: PostgresQueryClient) => Promise<TResult>,
): Promise<TResult> {
  let queue = POSTGRES_TRANSACTION_QUEUES.get(client);
  if (queue === undefined) {
    queue = new PQueue({ concurrency: 1 });
    POSTGRES_TRANSACTION_QUEUES.set(client, queue);
  }
  return queue.add(async (): Promise<TResult> => {
    const pinned = client.connect !== undefined ? await client.connect() : undefined;
    const txClient: PostgresQueryClient = pinned ?? client;
    try {
      await txClient.query('BEGIN');
      try {
        const result = await work(txClient);
        await txClient.query('COMMIT');
        return result;
      } catch (error) {
        await txClient.query('ROLLBACK').catch(() => undefined);
        throw error;
      }
    } finally {
      pinned?.release();
    }
  });
}
