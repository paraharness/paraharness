import type { AstBuilder, SqliteLedgerNode } from '@metaharness/core';
import type { CompactionConfigBuilder } from './compaction-config-builder.js';

/**
 * Fluent builder for a passive `SqliteLedgerNode` (`sqlite.ledger(uri)`).
 *
 * Configures a WAL-mode SQLite ledger store and optional wire-frame compaction triggers
 * without opening database connections at declaration time.
 */
export interface SqliteLedgerBuilder extends AstBuilder<SqliteLedgerNode> {
  /**
   * Attaches a wire-frame compaction policy to the SQLite ledger store.
   *
   * Invokes `configure` with a fresh `CompactionConfigBuilder` and returns a new immutable ledger builder.
   *
   * @param {(builder: CompactionConfigBuilder) => CompactionConfigBuilder} configure - Pure configurator callback.
   *
   * @returns {SqliteLedgerBuilder} Updated immutable SQLite ledger builder.
   */
  compactWhen(
    configure: (builder: CompactionConfigBuilder) => CompactionConfigBuilder,
  ): SqliteLedgerBuilder;
}
