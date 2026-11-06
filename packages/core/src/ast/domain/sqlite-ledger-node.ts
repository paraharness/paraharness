import type { BaseLedgerStoreASTNode } from '../base/base-ledger-store-ast-node.js';
import type { CompactionConfigNode } from '../compaction-config-node.js';

/**
 * Passive AST node configuring a WAL-mode SQLite ledger store (`sqlite.ledger`).
 *
 * Persists run state machines, fencing tokens, scope lease ledgers, and wire-frame records
 * inside a local SQLite database file or in-memory database.
 */
export interface SqliteLedgerNode extends BaseLedgerStoreASTNode<'sqlite:ledger'> {
  /** Host-root-relative SQLite database file path or `:memory:` URI. */
  readonly uri: string;
  /** Optional wire-frame compaction policy. */
  readonly compaction?: CompactionConfigNode;
}
