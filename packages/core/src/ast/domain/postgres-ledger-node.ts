import type { BaseLedgerStoreASTNode } from '../base/base-ledger-store-ast-node.js';
import type { CompactionConfigNode } from '../compaction-config-node.js';
import type { EnvRef } from '../env-ref.js';

/**
 * Passive AST node configuring a PostgreSQL ledger store (`postgres.ledger`).
 *
 * Persists run state machines, fencing tokens, scope lease ledgers, and wire-frame records
 * inside a transactional PostgreSQL database.
 */
export interface PostgresLedgerNode extends BaseLedgerStoreASTNode<'postgres:ledger'> {
  /** PostgreSQL connection URI or symbolic `EnvRef`. */
  readonly uri: string | EnvRef;
  /** Optional wire-frame compaction policy. */
  readonly compaction?: CompactionConfigNode;
}
