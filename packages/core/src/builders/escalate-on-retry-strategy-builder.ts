import type { AstBuilder } from '../ast/ast-builder.js';
import type { EscalateOnRetryPoolStrategyNode } from '../ast/escalate-on-retry-pool-strategy-node.js';

/**
 * Fluent configurator for `'escalate-on-retry'` pool strategies (`$.escalateOnRetry()`).
 *
 * Configures empirical completion success-rate and sample-count thresholds used to
 * escalate across ordered candidate models in a pool across retry attempts.
 *
 * @template TItem Pool item AST node type.
 */
export interface EscalateOnRetryStrategyBuilder<TItem = unknown>
  extends AstBuilder<EscalateOnRetryPoolStrategyNode> {
  /**
   * Sets the minimum empirical completion success rate required before escalating to the next model in the pool.
   *
   * Candidates whose empirical success rate falls below `rate` after `minSamples` are skipped on retry.
   *
   * @param {number} rate - Minimum empirical success rate in $[0, 1]$.
   *
   * @returns {EscalateOnRetryStrategyBuilder<TItem>} New immutable strategy builder.
   */
  minSuccessRate(rate: number): EscalateOnRetryStrategyBuilder<TItem>;

  /**
   * Sets the minimum sample count required before evaluating `minSuccessRate`.
   *
   * Candidates with fewer than `count` recorded invocations are not penalized by `minSuccessRate`.
   *
   * @param {number} count - Minimum number of recorded invocations.
   *
   * @returns {EscalateOnRetryStrategyBuilder<TItem>} New immutable strategy builder.
   */
  minSamples(count: number): EscalateOnRetryStrategyBuilder<TItem>;
}
