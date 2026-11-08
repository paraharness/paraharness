import type { PostgresPinnedClient } from './postgres-pinned-client.js';

/**
 * Normalized query result returned by a `PostgresQueryClient.query()` invocation.
 *
 * Wraps the typed result rows and affected row count returned by a parameterized PostgreSQL statement.
 *
 * @template TRow Row object shape returned by `SELECT` or `RETURNING` queries.
 */
export interface PostgresQueryResult<TRow = Record<string, unknown>> {
  /** Ordered array of typed result rows returned by the query. */
  readonly rows: readonly TRow[];
  /** Number of rows returned or affected by the SQL statement. */
  readonly rowCount: number;
}

/**
 * Minimal asynchronous PostgreSQL query client contract used by `@metaharness/postgres` stores and executors.
 *
 * Compatible with `pg.Pool` (`node-postgres`), `pg.Client`, and `@electric-sql/pglite` test fixtures,
 * supporting optional `connect()` transaction pinning when backed by a connection pool.
 */
export interface PostgresQueryClient {
  /**
   * Executes a parameterized SQL statement (`$1, $2, ...`) and returns its typed rows and affected row count.
   *
   * Supports both DDL/DML statements and `SELECT` queries with positional parameter arrays.
   *
   * @template TRow Expected row record shape.
   *
   * @param {string}             sql      - Parameterized SQL query string.
   * @param {readonly unknown[]} [params] - Optional positional parameter values bound to `$1..$n`.
   *
   * @returns {Promise<PostgresQueryResult<TRow>>} Normalized rows and affected row count.
   */
  query<TRow = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<PostgresQueryResult<TRow>>;

  /**
   * Optionally checks out a dedicated connection from a backing pool (`pg.Pool.connect()`) for transaction pinning.
   *
   * When present, `runInPostgresTransaction` acquires a pinned client before `BEGIN` and calls `release()` in `finally`.
   *
   * @returns {Promise<PostgresPinnedClient>} Dedicated pinned client connection.
   */
  connect?(): Promise<PostgresPinnedClient>;

  /**
   * Optionally releases or closes the underlying connection pool or client handle.
   *
   * Invoked when tearing down a store or test fixture instance.
   *
   * @returns {Promise<void> | void} Resolves once the underlying client resources are released.
   */
  close?(): Promise<void> | void;
}
