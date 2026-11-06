import type { AstBuilder } from '../ast/ast-builder.js';
import type { PoolStrategyNode } from '../ast/pool-strategy-node.js';
import type { PoolSelectorFn } from '../ast/pool-selector.types.js';
import type { EscalateOnRetryStrategyBuilder } from './escalate-on-retry-strategy-builder.js';

/**
 * Fluent configurator passed to `H.pool(id).strategy(($) => ...)`.
 *
 * Exposes `.escalateOnRetry()` and `.custom(selector)` strategy builders for model
 * and capacity pools.
 *
 * @template TItem Pool item AST node type.
 */
export interface PoolStrategyBuilder<TItem = unknown> {
  /**
   * Selects the `'escalate-on-retry'` model escalation strategy.
   *
   * Advances to the next candidate in the pool on retry or when empirical success rates drop below threshold.
   *
   * @returns {EscalateOnRetryStrategyBuilder<TItem>} Fluent builder for configuring `minSuccessRate` and `minSamples`.
   */
  escalateOnRetry(): EscalateOnRetryStrategyBuilder<TItem>;

  /**
   * Selects a custom `PoolSelectorFn<TItem>` or compiled `PoolStrategyNode<TItem>`.
   *
   * Wraps the provided selector callback or strategy node into an `AstBuilder<PoolStrategyNode<TItem>>`.
   *
   * @param {PoolSelectorFn<TItem> | PoolStrategyNode<TItem>} selectorOrNode - Custom selector callback or strategy node.
   *
   * @returns {AstBuilder<PoolStrategyNode<TItem>>} Strategy builder wrapping the custom selector.
   */
  custom(
    selectorOrNode: PoolSelectorFn<TItem> | PoolStrategyNode<TItem>,
  ): AstBuilder<PoolStrategyNode<TItem>>;
}

export type { PoolStrategyBuilder as PoolStrategyConfigurator };
