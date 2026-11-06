import type { EscalateOnRetryPoolStrategyNode } from '../../ast/pool-strategy-node.js';
import type { EscalateOnRetryStrategyBuilder } from '../escalate-on-retry-strategy-builder.js';
import { deepFreeze } from './deep-freeze.js';

/**
 * Creates an `EscalateOnRetryStrategyBuilder` instance for `$.escalateOnRetry()`.
 *
 * Captures empirical `minSuccessRate` and `minSamples` thresholds for escalating across
 * candidate models on retry.
 *
 * @template TItem Pool item type.
 *
 * @param {string}             poolId         - Owning pool identifier.
 * @param {number | undefined} minSuccessRate - Minimum empirical success rate threshold.
 * @param {number | undefined} minSamples     - Minimum empirical sample count threshold.
 *
 * @returns {EscalateOnRetryStrategyBuilder<TItem>} Frozen strategy builder.
 */
export function createEscalateOnRetryBuilder<TItem>(
  poolId: string,
  minSuccessRate: number | undefined,
  minSamples: number | undefined,
): EscalateOnRetryStrategyBuilder<TItem> {
  return Object.freeze<EscalateOnRetryStrategyBuilder<TItem>>({
    minSuccessRate(rate: number): EscalateOnRetryStrategyBuilder<TItem> {
      return createEscalateOnRetryBuilder(poolId, rate, minSamples);
    },
    minSamples(count: number): EscalateOnRetryStrategyBuilder<TItem> {
      return createEscalateOnRetryBuilder(poolId, minSuccessRate, count);
    },
    toAST(): EscalateOnRetryPoolStrategyNode {
      return deepFreeze<EscalateOnRetryPoolStrategyNode>({
        type: 'harness:pool-strategy',
        id: `${poolId}:escalate-on-retry`,
        strategyKind: 'escalate-on-retry',
        minSuccessRate,
        minSamples,
      });
    },
  });
}
