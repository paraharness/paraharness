import type { MaybeBuilder } from '../ast/ast-foundation.types.js';
import type { AstBuilder } from '../ast/ast-builder.js';
import type { ASTNode } from '../ast/ast-node.js';
import type { PoolNode } from '../ast/pool-node.js';
import type { PoolStrategyNode } from '../ast/pool-strategy.types.js';
import type { PoolSelectorFn } from '../ast/pool-strategy.types.js';
import type { PoolStrategyBuilder } from './pool-strategy-builder.js';

/**
 * Fluent builder for capacity and model pools (`H.pool(id)`).
 *
 * Aggregates ordered candidate items (`AccountSeatASTNode` or `ModelASTNode`) with a
 * selection strategy and optional fallback item.
 *
 * @template TItem Pool candidate AST node type.
 */
export interface PoolBuilder<TItem extends ASTNode = ASTNode>
  extends AstBuilder<PoolNode<TItem>> {
  /** Unique identifier of the pool. */
  readonly id: string;

  /**
   * Populates the pool with candidate items (`AccountSeatASTNode` or `ModelASTNode`).
   *
   * Replaces the candidate list and narrows the pool's item type parameter to `TNextItem`.
   *
   * @template TNextItem Candidate AST node type.
   *
   * @param {...ReadonlyArray<MaybeBuilder<TNextItem>>} items - Candidate AST nodes or builders.
   *
   * @returns {PoolBuilder<TNextItem>} New immutable pool builder typed to `TNextItem`.
   */
  with<TNextItem extends ASTNode>(
    ...items: ReadonlyArray<MaybeBuilder<TNextItem>>
  ): PoolBuilder<TNextItem>;

  /**
   * Configures the pool's selection strategy via a fluent `PoolStrategyBuilder` configurator callback.
   *
   * Enables fluent configuration of `.escalateOnRetry()`, `.minSuccessRate()`, `.minSamples()`,
   * or `.soonestReset()` / `.roundRobin()` / `.leastUsed()` on `$`.
   *
   * @param {($: PoolStrategyBuilder<TItem>) => MaybeBuilder<PoolStrategyNode<TItem>>} configure - Fluent strategy configurator callback.
   *
   * @returns {PoolBuilder<TItem>} New immutable pool builder.
   */
  strategy(
    configure: ($: PoolStrategyBuilder<TItem>) => MaybeBuilder<PoolStrategyNode<TItem>>,
  ): PoolBuilder<TItem>;

  /**
   * Configures the pool's selection strategy via a custom synchronous candidate selector function.
   *
   * Receives candidate states (`readonly PoolCandidateState<TItem>[]`) and `PoolSelectionContext`
   * (containing `attempt`, `runId`, and `stepExecId`) to pick a candidate item.
   *
   * @param {PoolSelectorFn<TItem>} selectFn - Custom synchronous selector function.
   *
   * @returns {PoolBuilder<TItem>} New immutable pool builder.
   */
  strategy(selectFn: PoolSelectorFn<TItem>): PoolBuilder<TItem>;

  /**
   * Configures the pool's selection strategy via a built-in strategy name, custom selector function, strategy node, or fluent configurator callback.
   *
   * Defaults to `'round-robin'` when `.strategy(...)` is not explicitly called.
   *
   * @param {'soonest-reset' | 'round-robin' | 'least-used' | PoolStrategyNode<TItem> | PoolSelectorFn<TItem> | (($: PoolStrategyBuilder<TItem>) => MaybeBuilder<PoolStrategyNode<TItem>>)} strategyInput - Strategy specification.
   *
   * @returns {PoolBuilder<TItem>} New immutable pool builder.
   */
  strategy(
    strategyInput:
      | 'soonest-reset'
      | 'round-robin'
      | 'least-used'
      | PoolStrategyNode<TItem>
      | PoolSelectorFn<TItem>
      | (($: PoolStrategyBuilder<TItem>) => MaybeBuilder<PoolStrategyNode<TItem>>),
  ): PoolBuilder<TItem>;

  /**
   * Configures a fallback item used when all primary candidates in the pool are rate-limited or exhausted.
   *
   * Extracts the underlying AST node from `item` and stores it on `PoolNode.fallbackItem`.
   *
   * @param {MaybeBuilder<TItem>} item - Fallback candidate AST node or builder.
   *
   * @returns {PoolBuilder<TItem>} New immutable pool builder.
   */
  fallback(item: MaybeBuilder<TItem>): PoolBuilder<TItem>;
}
