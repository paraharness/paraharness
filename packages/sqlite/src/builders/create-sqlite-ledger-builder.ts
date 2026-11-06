import type { CompactionConfigNode, SqliteLedgerNode } from '@harness-dsl/core';
import type { CompactionConfigBuilder } from './compaction-config-builder.js';
import { createCompactionConfigBuilder } from './create-compaction-config-builder.js';
import type { SqliteLedgerBuilder } from './sqlite-ledger-builder.js';

/**
 * Creates an immutable `SqliteLedgerBuilder` targeting `uri`.
 *
 * Validates that `uri` is non-empty and produces passive `SqliteLedgerNode` AST descriptors
 * with zero import-time or builder-time filesystem I/O.
 *
 * @param {string}               uri          - Host-root-relative SQLite file path or `:memory:` URI.
 * @param {CompactionConfigNode} [compaction] - Optional pre-compiled compaction configuration node.
 *
 * @returns {SqliteLedgerBuilder} Frozen SQLite ledger AST builder.
 */
export function createSqliteLedgerBuilder(
  uri: string,
  compaction?: CompactionConfigNode,
): SqliteLedgerBuilder {
  if (uri.trim().length === 0) {
    throw new Error('sqlite.ledger(uri) requires a non-empty database URI.');
  }
  return Object.freeze<SqliteLedgerBuilder>({
    compactWhen(
      configure: (builder: CompactionConfigBuilder) => CompactionConfigBuilder,
    ): SqliteLedgerBuilder {
      const nextCompaction = configure(createCompactionConfigBuilder()).toAST();
      return createSqliteLedgerBuilder(uri, nextCompaction);
    },
    toAST(): SqliteLedgerNode {
      return Object.freeze<SqliteLedgerNode>({
        type: 'sqlite:ledger',
        uri,
        compaction,
      });
    },
  });
}
