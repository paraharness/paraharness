import type { EnvRef } from '@metaharness/core';
import type { PostgresGlobalRulesBuilder } from './postgres-global-rules-builder.js';
import type { PostgresLedgerBuilder } from './postgres-ledger-builder.js';
import type { PostgresLessonsBuilder } from './postgres-lessons-builder.js';
import type { PostgresTopologyBuilder } from './postgres-topology-builder.js';

/**
 * Options passed to `postgres.globalRules(uri, options)`.
 *
 * Specifies the relational table name storing `(id, directive)` rows and an optional source identifier.
 */
export interface PostgresGlobalRulesOptions {
  /** Relational PostgreSQL table name storing `(id, directive)` global rule rows. */
  readonly table: string;
  /** Optional explicit source node identifier. */
  readonly id?: string;
}

/**
 * Public `postgres` adapter builder namespace contract (`@metaharness/postgres`).
 *
 * Provides pure, side-effect-free AST builders for PostgreSQL-backed durable ledgers,
 * relational CoW topology stores, empirical lesson stores, and global rule sources.
 */
export interface PostgresNamespace {
  /**
   * Declares a PostgreSQL-backed durable execution ledger (`postgres:ledger`).
   *
   * Returns a fluent builder supporting `.compactWhen(...)` wire-frame pruning policies.
   *
   * @param {string | EnvRef} uri - PostgreSQL connection URI or symbolic `M.env(...)` reference.
   *
   * @returns {PostgresLedgerBuilder} Fluent builder supporting `.compactWhen(...)` and `.toAST()`.
   */
  ledger(uri: string | EnvRef): PostgresLedgerBuilder;

  /**
   * Declares a PostgreSQL-backed relational Copy-on-Write topology store (`postgres:topology`).
   *
   * Returns a fluent builder compiling to an immutable `PostgresTopologyNode`.
   *
   * @param {string | EnvRef} uri - PostgreSQL connection URI or symbolic `M.env(...)` reference.
   *
   * @returns {PostgresTopologyBuilder} Fluent builder compiling to `PostgresTopologyNode`.
   */
  topologyStore(uri: string | EnvRef): PostgresTopologyBuilder;

  /**
   * Declares a PostgreSQL-backed empirical lesson store (`postgres:lessons`).
   *
   * Returns a fluent builder compiling to an immutable `PostgresLessonsNode`.
   *
   * @param {string | EnvRef} uri - PostgreSQL connection URI or symbolic `M.env(...)` reference.
   *
   * @returns {PostgresLessonsBuilder} Fluent builder compiling to `PostgresLessonsNode`.
   */
  lessonStore(uri: string | EnvRef): PostgresLessonsBuilder;

  /**
   * Declares a PostgreSQL-backed global rules grounding source (`postgres:global-rules`).
   *
   * Validates `options.table` as a safe SQL identifier and compiles to `PostgresRulesSourceNode`.
   *
   * @param {string | EnvRef}            uri     - PostgreSQL connection URI or symbolic `M.env(...)` reference.
   * @param {PostgresGlobalRulesOptions} options - Configuration specifying the SQL table name.
   *
   * @returns {PostgresGlobalRulesBuilder} Fluent builder compiling to `PostgresRulesSourceNode`.
   */
  globalRules(
    uri: string | EnvRef,
    options: PostgresGlobalRulesOptions,
  ): PostgresGlobalRulesBuilder;
}
