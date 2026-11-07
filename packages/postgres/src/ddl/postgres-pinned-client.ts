import type { PostgresQueryClient } from './postgres-query-client.js';

/**
 * Dedicated PostgreSQL connection checked out from a connection pool (`pg.PoolClient` or test adapter)
 * for the duration of a single `BEGIN` / `COMMIT` / `ROLLBACK` transaction.
 *
 * Ensures all queries inside a transaction execute on the same backend session and releases the client
 * back to the pool inside a `finally` block.
 */
export interface PostgresPinnedClient extends PostgresQueryClient {
  /**
   * Releases the pinned connection back to the originating pool.
   *
   * Invoked unconditionally inside `runInPostgresTransaction`'s `finally` block after `COMMIT` or `ROLLBACK`.
   *
   * @param {Error | boolean} [err] - Optional error or disposal flag indicating whether the backend connection should be destroyed.
   *
   * @returns {void} Returns nothing once the connection is returned to the pool.
   */
  release(err?: Error | boolean): void;
}
