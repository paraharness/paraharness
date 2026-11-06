import type { PoolStrategyNode } from './pool-strategy-node.js';

/**
 * Passive AST node representing a capacity pool of account seats or models.
 *
 * Multiplexes concurrent access across `items` using `strategy` and cascades to
 * `fallbackItem` when all primary candidates are rate-limited.
 *
 * @template TItem Pooled resource item type.
 */
export interface PoolNode<TItem = unknown> {
  /** Discriminant identifying a capacity pool AST node. */
  readonly type: 'harness:pool';
  /** Unique logical identifier of the pool. */
  readonly id: string;
  /** Ordered list of primary candidate items managed by the pool. */
  readonly items: readonly TItem[];
  /** Selection strategy governing candidate routing and retry escalation. */
  readonly strategy: PoolStrategyNode<TItem>;
  /** Optional fallback item used when all primary candidates are exhausted or rate-limited. */
  readonly fallbackItem?: TItem;
}
