import type { PostgresQueryResult } from './postgres-query-result.js';

/**
 * Minimal asynchronous PostgreSQL query client contract used by `@harness-dsl/postgres` stores and executors.
 *
 * Compatible with `pg.Pool`, `pg.Client`, `Postgres.js` wrappers, and `SqliteBackedPgClient` test fixtures
 * without requiring an external `pg` npm runtime dependency.
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
   * Optionally releases or closes the underlying connection pool or client handle.
   *
   * Invoked when tearing down a store or test fixture instance.
   *
   * @returns {Promise<void> | void} Resolves once the underlying client resources are released.
   */
  close?(): Promise<void> | void;
}
