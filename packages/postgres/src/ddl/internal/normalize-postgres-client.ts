import { Pool } from 'pg';
import type { PostgresPinnedClient } from '../postgres-pinned-client.js';
import type { PostgresQueryClient } from '../postgres-query-client.js';
import type { PostgresQueryResult } from '../postgres-query-result.js';
import {
  POSTGRES_POOL_WRAPPERS,
  POSTGRES_URI_POOLS,
} from '../postgres-schema.constants.js';

/**
 * Executes a parameterized query against a `pg.Pool` or `pg.PoolClient` and normalizes the returned rows and row count.
 *
 * Converts `readonly unknown[]` parameter slices into mutable arrays accepted by `node-postgres`.
 *
 * @template TRow Expected row record shape.
 *
 * @param {{ query: Pool['query'] }} target - Backing `pg.Pool` or `pg.PoolClient` instance.
 * @param {string}                   sql    - Parameterized SQL query string.
 * @param {readonly unknown[]}       [args] - Optional positional parameter array.
 *
 * @returns {Promise<PostgresQueryResult<TRow>>} Normalized query result.
 */
async function executePgTargetQuery<TRow = Record<string, unknown>>(
  target: { query: Pool['query'] },
  sql: string,
  args?: readonly unknown[],
): Promise<PostgresQueryResult<TRow>> {
  const res = await target.query<Record<string, unknown>>(
    sql,
    args !== undefined ? [...args] : undefined,
  );
  return Object.freeze<PostgresQueryResult<TRow>>({
    rows: Object.freeze(res.rows as TRow[]),
    rowCount: res.rowCount ?? 0,
  });
}

/**
 * Wraps a `node-postgres` (`pg.Pool`) instance into a `PostgresQueryClient` with `.connect()` transaction pinning.
 *
 * Memoizes the wrapper per `Pool` instance in `POSTGRES_POOL_WRAPPERS` so repeated resolutions share the same queue.
 *
 * @param {Pool} pool - `node-postgres` connection pool instance.
 *
 * @returns {PostgresQueryClient} Adapted query client supporting `.connect()` and `.close()`.
 */
export function adaptPgPoolToQueryClient(pool: Pool): PostgresQueryClient {
  const existing = POSTGRES_POOL_WRAPPERS.get(pool);
  if (existing !== undefined) return existing;
  const adapted = Object.freeze<PostgresQueryClient>({
    query<TRow = Record<string, unknown>>(
      sql: string,
      params?: readonly unknown[],
    ): Promise<PostgresQueryResult<TRow>> {
      return executePgTargetQuery<TRow>(pool, sql, params);
    },
    async connect(): Promise<PostgresPinnedClient> {
      const poolClient = await pool.connect();
      return Object.freeze<PostgresPinnedClient>({
        query<TRow = Record<string, unknown>>(
          sql: string,
          params?: readonly unknown[],
        ): Promise<PostgresQueryResult<TRow>> {
          return executePgTargetQuery<TRow>(poolClient, sql, params);
        },
        release(err?: Error | boolean): void {
          poolClient.release(err);
        },
      });
    },
    async close(): Promise<void> {
      await pool.end();
    },
  });
  POSTGRES_POOL_WRAPPERS.set(pool, adapted);
  return adapted;
}

/**
 * Normalizes a connection URI string, `pg.Pool`, or `PostgresQueryClient` into a `PostgresQueryClient`.
 *
 * Reuses memoized `pg.Pool` instances per connection string in `POSTGRES_URI_POOLS` when given a URI string.
 *
 * @param {PostgresQueryClient | Pool | string} clientOrPoolOrUri - Query client, `pg.Pool`, or PostgreSQL connection URI.
 *
 * @returns {PostgresQueryClient} Normalized `PostgresQueryClient` instance.
 */
export function normalizePostgresClient(
  clientOrPoolOrUri: PostgresQueryClient | Pool | string,
): PostgresQueryClient {
  if (typeof clientOrPoolOrUri === 'string') {
    const trimmed = clientOrPoolOrUri.trim();
    if (trimmed.length === 0) {
      throw new Error('Cannot open PostgreSQL connection: connection URI string is empty.');
    }
    const existing = POSTGRES_URI_POOLS.get(trimmed);
    if (existing !== undefined) return existing;
    const created = adaptPgPoolToQueryClient(new Pool({ connectionString: trimmed }));
    POSTGRES_URI_POOLS.set(trimmed, created);
    return created;
  }
  if (clientOrPoolOrUri instanceof Pool) {
    return adaptPgPoolToQueryClient(clientOrPoolOrUri);
  }
  return clientOrPoolOrUri;
}

/**
 * Wraps an asynchronously resolved `Promise<PostgresQueryClient>` into a synchronous `PostgresQueryClient` handle.
 *
 * Forwards `query`, `connect` (preserving pooled transaction pinning when the resolved client defines `connect()`),
 * and `close` to the resolved underlying client.
 *
 * @param {Promise<PostgresQueryClient>} pendingClient - Asynchronously resolving PostgreSQL query client.
 *
 * @returns {PostgresQueryClient} Synchronous `PostgresQueryClient` proxy.
 */
export function wrapAsyncPostgresClient(
  pendingClient: Promise<PostgresQueryClient>,
): PostgresQueryClient {
  return Object.freeze<PostgresQueryClient>({
    async query<TRow = Record<string, unknown>>(
      sql: string,
      params?: readonly unknown[],
    ): Promise<PostgresQueryResult<TRow>> {
      const client = await pendingClient;
      return client.query<TRow>(sql, params);
    },
    async connect(): Promise<PostgresPinnedClient> {
      const client = await pendingClient;
      if (client.connect !== undefined) {
        return client.connect();
      }
      return Object.freeze<PostgresPinnedClient>({
        query<TRow = Record<string, unknown>>(
          sql: string,
          params?: readonly unknown[],
        ): Promise<PostgresQueryResult<TRow>> {
          return client.query<TRow>(sql, params);
        },
        release(): void {},
      });
    },
    async close(): Promise<void> {
      const client = await pendingClient;
      await client.close?.();
    },
  });
}
