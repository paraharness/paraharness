import type { CustomPoolStrategyNode } from './custom-pool-strategy-node.js';
import type { EscalateOnRetryPoolStrategyNode } from './escalate-on-retry-pool-strategy-node.js';
import type { PoolCandidateState } from './pool-candidate-state.js';
import type { PoolSelectionContext } from './pool-selection-context.js';
import type { StandardPoolStrategyNode } from './standard-pool-strategy-node.js';

export type { CustomPoolStrategyNode } from './custom-pool-strategy-node.js';
export type { EscalateOnRetryPoolStrategyNode } from './escalate-on-retry-pool-strategy-node.js';
export type { StandardPoolStrategyNode } from './standard-pool-strategy-node.js';

/**
 * Custom synchronous selector function passed to `H.pool(id).strategy(fn)`.
 *
 * @template TItem Pooled resource item type.
 */
export type PoolSelectorFn<TItem = unknown> = (
  candidates: readonly PoolCandidateState<TItem>[],
  ctx: PoolSelectionContext,
) => TItem;

/**
 * Discriminated union of passive capacity pool selection strategy AST nodes.
 *
 * @template TItem Pooled resource item type.
 */
export type PoolStrategyNode<TItem = unknown> =
  | StandardPoolStrategyNode
  | EscalateOnRetryPoolStrategyNode
  | CustomPoolStrategyNode<TItem>;
