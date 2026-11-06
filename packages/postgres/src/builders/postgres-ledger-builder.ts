import type { AstBuilder, PostgresLedgerNode } from '@harness-dsl/core';
import type { CompactionConfigBuilder } from './compaction-config-builder.js';

/**
 * Fluent builder for a passive `PostgresLedgerNode` (`postgres:ledger`) AST node.
 *
 * Captures the PostgreSQL connection URI (or late-bound `EnvRef`) and optional raw wire frame
 * compaction policy without opening any database socket at declaration time.
 */
export interface PostgresLedgerBuilder extends AstBuilder<PostgresLedgerNode> {
  /**
   * Attaches a wire-frame compaction policy to this PostgreSQL ledger configuration.
   *
   * Invokes `configure` with a fresh `CompactionConfigBuilder` and returns a new immutable builder.
   *
   * @param {(builder: CompactionConfigBuilder) => CompactionConfigBuilder} configure - Callback configuring compaction triggers.
   *
   * @returns {PostgresLedgerBuilder} New immutable builder instance with the compiled compaction policy attached.
   */
  compactWhen(
    configure: (builder: CompactionConfigBuilder) => CompactionConfigBuilder,
  ): PostgresLedgerBuilder;

  /**
   * Compiles the builder configuration into a frozen `PostgresLedgerNode` AST node.
   *
   * Preserves the connection URI or `EnvRef` and optional `CompactionConfigNode`.
   *
   * @returns {PostgresLedgerNode} Deeply frozen passive `postgres:ledger` AST node.
   */
  toAST(): PostgresLedgerNode;
}
