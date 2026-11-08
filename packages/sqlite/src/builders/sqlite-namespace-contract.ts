import type { SqliteGlobalRulesBuilder } from './sqlite-global-rules-builder.js';
import type { SqliteLedgerBuilder } from './sqlite-ledger-builder.js';
import type { SqliteLessonsBuilder } from './sqlite-lessons-builder.js';
import type { SqliteTopologyBuilder } from './sqlite-topology-builder.js';

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

/**
 * Public builder namespace contract exported as `sqlite` from `@metaharness/sqlite`.
 *
 * Provides pure AST builder factories for SQLite-backed ledger, topology, lesson, and global rule stores.
 */
export interface SqliteNamespace {
  /**
   * Creates a fluent builder for a WAL-mode SQLite `LedgerStore` AST node (`type: 'sqlite:ledger'`).
   *
   * Supports `.compactWhen($c => ...)` wire-frame pruning configuration before compiling via `.toAST()`.
   *
   * @param {string} uri - Host-root-relative SQLite database path or `:memory:` URI.
   *
   * @returns {SqliteLedgerBuilder} Immutable SQLite ledger builder.
   */
  ledger(uri: string): SqliteLedgerBuilder;

  /**
   * Creates a fluent builder for a WAL-mode SQLite `TopologyStore` AST node (`type: 'sqlite:topology'`).
   *
   * Configures Copy-on-Write per-run partition contract overlays stored in SQLite.
   *
   * @param {string} uri - Host-root-relative SQLite database path or `:memory:` URI.
   *
   * @returns {SqliteTopologyBuilder} Immutable SQLite topology store builder.
   */
  topologyStore(uri: string): SqliteTopologyBuilder;

  /**
   * Creates a fluent builder for a WAL-mode SQLite `LessonStore` AST node (`type: 'sqlite:lessons'`).
   *
   * Configures empirical lesson storage, candidate recall, and outcome tracking in SQLite.
   *
   * @param {string} uri - Host-root-relative SQLite database path or `:memory:` URI.
   *
   * @returns {SqliteLessonsBuilder} Immutable SQLite lesson store builder.
   */
  lessonStore(uri: string): SqliteLessonsBuilder;

  /**
   * Creates a fluent builder for a SQLite global rules `SourceASTNode` (`type: 'sqlite:global-rules'`).
   *
   * Validates `options.table` as a strict SQL identifier and emits a passive `SqliteRulesSourceNode`.
   *
   * @param {string}                   uri     - Host-root-relative SQLite database path or `:memory:` URI.
   * @param {SqliteGlobalRulesOptions} options - Relational table configuration.
   *
   * @returns {SqliteGlobalRulesBuilder} Immutable SQLite global rules source builder.
   */
  globalRules(uri: string, options: SqliteGlobalRulesOptions): SqliteGlobalRulesBuilder;
}

