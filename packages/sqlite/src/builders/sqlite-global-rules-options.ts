/**
 * Options passed to `sqlite.globalRules(uri, options)`.
 *
 * Specifies the relational table name storing `(id, directive)` rows and an optional source identifier.
 */
export interface SqliteGlobalRulesOptions {
  /** Relational SQLite table name storing `(id, directive)` global rule rows. */
  readonly table: string;
  /** Optional explicit source node identifier. */
  readonly id?: string;
}
