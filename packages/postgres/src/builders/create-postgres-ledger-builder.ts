import type { CompactionConfigNode, EnvRef, PostgresLedgerNode } from '@paraharness/core';
import type { CompactionConfigBuilder } from './compaction-config-builder.js';
import { createCompactionConfigBuilder } from './create-compaction-config-builder.js';
import type { PostgresLedgerBuilder } from './postgres-ledger-builder.js';

/**
 * Creates a pure, side-effect-free `PostgresLedgerBuilder` for `postgres.ledger(uri)`.
 *
 * Stores the literal connection URI or symbolic `EnvRef` and optional `CompactionConfigNode`
 * in an immutable closure that compiles to a frozen `PostgresLedgerNode`.
 *
 * @param {string | EnvRef}                  uri          - PostgreSQL connection URI or symbolic `P.env(...)` reference.
 * @param {CompactionConfigNode | undefined} [compaction] - Optional pre-compiled compaction configuration.
 *
 * @returns {PostgresLedgerBuilder} Immutable builder for `PostgresLedgerNode`.
 */
export function createPostgresLedgerBuilder(
  uri: string | EnvRef,
  compaction?: CompactionConfigNode,
): PostgresLedgerBuilder {
  if (typeof uri === 'string' && uri.trim().length === 0) {
    throw new Error('postgres.ledger(uri) requires a non-empty database URI.');
  }
  return Object.freeze<PostgresLedgerBuilder>({
    compactWhen(
      configure: (builder: CompactionConfigBuilder) => CompactionConfigBuilder,
    ): PostgresLedgerBuilder {
      const configured = configure(createCompactionConfigBuilder()).toAST();
      return createPostgresLedgerBuilder(uri, configured);
    },
    toAST(): PostgresLedgerNode {
      return Object.freeze<PostgresLedgerNode>({
        type: 'postgres:ledger',
        uri,
        compaction,
      });
    },
  });
}
