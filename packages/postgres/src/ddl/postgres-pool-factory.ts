import type { PostgresQueryClient } from './postgres-query-client.js';

/**
 * Factory contract resolving a PostgreSQL connection URI into an active `PostgresQueryClient`.
 *
 * Supplied to `createPostgresExecutors(poolFactory)` so runtime ledger, topology, lesson, and
 * global-rule executors can open connections against late-bound `EnvRef` connection strings.
 */
export interface PostgresPoolFactory {
  /**
   * Acquires or creates a `PostgresQueryClient` for the resolved `connectionUri`.
   *
   * Implementations may memoize pools per URI or return a pre-configured client instance.
   *
   * @param {string} connectionUri - Resolved PostgreSQL connection URI.
   *
   * @returns {Promise<PostgresQueryClient> | PostgresQueryClient} Active query client for `connectionUri`.
   */
  getClient(connectionUri: string): Promise<PostgresQueryClient> | PostgresQueryClient;
}
