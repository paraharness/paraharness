/**
 * Options passed to `postgres.globalRules(uri, options)` specifying the backing PostgreSQL table.
 *
 * The table identifier is validated against `^[A-Za-z_][A-Za-z0-9_]*$` at both builder time
 * and runtime source execution time to prevent SQL injection.
 */
export interface PostgresGlobalRulesOptions {
  /** Valid SQL table name storing `(id, directive)` global rule rows. */
  readonly table: string;
  /** Optional explicit source node identifier. */
  readonly id?: string;
}
