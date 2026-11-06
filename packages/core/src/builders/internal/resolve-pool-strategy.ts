import type { MaybeBuilder } from '../../ast/ast-foundation.types.js';
import type { AstBuilder } from '../../ast/ast-builder.js';
import { extractAST } from '../../ast/extract-ast.js';
import type {
  CustomPoolStrategyNode,
  PoolStrategyNode,
  StandardPoolStrategyNode,
} from '../../ast/pool-strategy-node.js';
import type { PoolSelectorFn } from '../../ast/pool-selector.types.js';
import type { EscalateOnRetryStrategyBuilder } from '../escalate-on-retry-strategy-builder.js';
import type { PoolStrategyConfigurator } from '../pool-strategy-builder.js';
import { createEscalateOnRetryBuilder } from './create-escalate-on-retry-builder.js';
import { deepFreeze } from './deep-freeze.js';

export { createEscalateOnRetryBuilder };

/**
 * Resolves the `strategy(...)` argument on `PoolBuilder` into a compiled `PoolStrategyNode<TItem>`.
 *
 * Accepts built-in strategy names (`'soonest-reset'`, `'round-robin'`, `'least-used'`),
 * pre-built `PoolStrategyNode` objects, custom `PoolSelectorFn` callbacks, or fluent
 * `PoolStrategyConfigurator` callbacks.
 *
 * @template TItem Pool item type.
 *
 * @param {string}  poolId - Owning pool identifier.
 * @param {unknown} input  - Strategy specification name, node, selector, or callback.
 *
 * @returns {PoolStrategyNode<TItem>} Compiled passive `PoolStrategyNode`.
 */
export function resolvePoolStrategy<TItem>(
  poolId: string,
  input:
    | 'soonest-reset'
    | 'round-robin'
    | 'least-used'
    | PoolStrategyNode<TItem>
    | PoolSelectorFn<TItem>
    | (($: PoolStrategyConfigurator<TItem>) => MaybeBuilder<PoolStrategyNode<TItem>>),
): PoolStrategyNode<TItem> {
  if (input === 'soonest-reset' || input === 'round-robin' || input === 'least-used') {
    return deepFreeze<StandardPoolStrategyNode>({
      type: 'harness:pool-strategy',
      id: `${poolId}:${input}`,
      strategyKind: input,
    });
  }
  if (typeof input === 'object' && input !== null && 'type' in input) {
    return deepFreeze<PoolStrategyNode<TItem>>(input);
  }
  const configurator: PoolStrategyConfigurator<TItem> = {
    escalateOnRetry: (): EscalateOnRetryStrategyBuilder<TItem> =>
      createEscalateOnRetryBuilder<TItem>(poolId, undefined, undefined),
    custom: (
      selectorOrNode: PoolSelectorFn<TItem> | PoolStrategyNode<TItem>,
    ): AstBuilder<PoolStrategyNode<TItem>> =>
      Object.freeze<AstBuilder<PoolStrategyNode<TItem>>>({
        toAST: (): PoolStrategyNode<TItem> =>
          typeof selectorOrNode === 'function'
            ? deepFreeze<CustomPoolStrategyNode<TItem>>({
                type: 'harness:pool-strategy',
                id: `${poolId}:custom`,
                strategyKind: 'custom',
                selectFn: selectorOrNode,
              })
            : deepFreeze<PoolStrategyNode<TItem>>(selectorOrNode),
      }),
  };
  if (typeof input === 'function') {
    if (input.length >= 2) {
      const selectFn = input as PoolSelectorFn<TItem>;
      return deepFreeze<CustomPoolStrategyNode<TItem>>({
        type: 'harness:pool-strategy',
        id: `${poolId}:custom`,
        strategyKind: 'custom',
        selectFn,
      });
    }
    const configCallback = input as (
      $: PoolStrategyConfigurator<TItem>,
    ) => MaybeBuilder<PoolStrategyNode<TItem>>;
    const built = configCallback(configurator);
    if (typeof built === 'object' && built !== null && ('toAST' in built || 'type' in built)) {
      return extractAST(built);
    }
    const fallbackSelectFn = input as PoolSelectorFn<TItem>;
    return deepFreeze<CustomPoolStrategyNode<TItem>>({
      type: 'harness:pool-strategy',
      id: `${poolId}:custom`,
      strategyKind: 'custom',
      selectFn: fallbackSelectFn,
    });
  }
  return deepFreeze<StandardPoolStrategyNode>({
    type: 'harness:pool-strategy',
    id: `${poolId}:round-robin`,
    strategyKind: 'round-robin',
  });
}
