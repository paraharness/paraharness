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
