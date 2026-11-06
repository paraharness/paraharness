import type { CompactionConfigNode } from '../compaction-config-node.js';

/**
 * Domain-agnostic base AST node contract for durable execution ledger stores (`LedgerStoreASTNode`).
 *
 * Resolved against the host process root via `RuntimeExecutorRegistry.ledgers[node.type]`
 * into a `LedgerStore` instance.
 *
 * @template TType String-literal discriminant of the ledger store node.
 */
export interface BaseLedgerStoreASTNode<TType extends string = string> {
  /** Unique string-literal discriminant of the ledger store node. */
  readonly type: TType;
  /** Optional wire-frame compaction policy attached to this ledger store. */
  readonly compaction?: CompactionConfigNode;
}
