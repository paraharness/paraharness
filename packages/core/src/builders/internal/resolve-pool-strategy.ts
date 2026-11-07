import type { AstBuilder } from '../../ast/ast-builder.js';
import type { MaybeBuilder } from '../../ast/ast-foundation.types.js';
import type { CustomPoolStrategyNode } from '../../ast/custom-pool-strategy-node.js';
import { extractAST } from '../../ast/extract-ast.js';
import type { PoolSelectorFn, PoolStrategyNode } from '../../ast/pool-strategy.types.js';
import type { StandardPoolStrategyNode } from '../../ast/standard-pool-strategy-node.js';
import type { EscalateOnRetryStrategyBuilder } from '../escalate-on-retry-strategy-builder.js';
import type { PoolStrategyBuilder } from '../pool-strategy-builder.js';
import { createEscalateOnRetryBuilder } from './create-escalate-on-retry-builder.js';
import { deepFreeze } from './deep-freeze.js';

/**
 * Attempts to evaluate a 0- or 1-argument function as a `PoolStrategyBuilder` configurator callback.
 *
 * Returns the compiled `PoolStrategyNode<TItem>` when the callback invokes `$.escalateOnRetry()` or
 * `$.custom(...)` (or returns a strategy builder/node), or `undefined` when the callback behaves as
 * a direct `PoolSelectorFn<TItem>`.
 *
 * @template TItem Pool item type.
 *
 * @param {string}                                                         poolId   - Owning pool identifier.
 * @param {($: PoolStrategyBuilder<TItem>) => MaybeBuilder<PoolStrategyNode<TItem>>} callback - Candidate configurator callback.
 *
 * @returns {PoolStrategyNode<TItem> | undefined} Compiled strategy node, or `undefined` if `callback` is a selector function.
 */
function tryResolveConfiguratorStrategy<TItem>(
  poolId: string,
  callback: ($: PoolStrategyBuilder<TItem>) => MaybeBuilder<PoolStrategyNode<TItem>>,
): PoolStrategyNode<TItem> | undefined {
  let usedConfigurator = false;
  const configurator: PoolStrategyBuilder<TItem> = {
    escalateOnRetry: (): EscalateOnRetryStrategyBuilder<TItem> => {
      usedConfigurator = true;
      return createEscalateOnRetryBuilder<TItem>(poolId, undefined, undefined);
    },
    custom: (
      selectorOrNode: PoolSelectorFn<TItem> | PoolStrategyNode<TItem>,
    ): AstBuilder<PoolStrategyNode<TItem>> => {
      usedConfigurator = true;
      return Object.freeze<AstBuilder<PoolStrategyNode<TItem>>>({
        toAST: (): PoolStrategyNode<TItem> =>
          typeof selectorOrNode === 'function'
            ? deepFreeze<CustomPoolStrategyNode<TItem>>({
                type: 'harness:pool-strategy',
                id: `${poolId}:custom`,
                strategyKind: 'custom',
                selectFn: selectorOrNode,
              })
            : deepFreeze<PoolStrategyNode<TItem>>(selectorOrNode),
      });
    },
  };
  try {
    const built = callback(configurator);
    const isStrategyResult =
      usedConfigurator ||
      (typeof built === 'object' &&
        built !== null &&
        (('toAST' in built && typeof built.toAST === 'function') ||
          ('type' in built && built.type === 'harness:pool-strategy')));
    if (isStrategyResult && typeof built === 'object' && built !== null) {
      return extractAST(built);
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/**
 * Resolves the `strategy(...)` argument on `PoolBuilder` into a compiled `PoolStrategyNode<TItem>`.
 *
 * Accepts built-in strategy names (`'soonest-reset'`, `'round-robin'`, `'least-used'`),
 * pre-built `PoolStrategyNode` objects, custom `PoolSelectorFn` callbacks, or fluent
 * `PoolStrategyBuilder` configurator callbacks.
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
    | (($: PoolStrategyBuilder<TItem>) => MaybeBuilder<PoolStrategyNode<TItem>>),
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
  if (typeof input === 'function') {
    if (input.length <= 1) {
      const configured = tryResolveConfiguratorStrategy(
        poolId,
        input as ($: PoolStrategyBuilder<TItem>) => MaybeBuilder<PoolStrategyNode<TItem>>,
      );
      if (configured !== undefined) {
        return configured;
      }
    }
    return deepFreeze<CustomPoolStrategyNode<TItem>>({
      type: 'harness:pool-strategy',
      id: `${poolId}:custom`,
      strategyKind: 'custom',
      selectFn: input as PoolSelectorFn<TItem>,
    });
  }
  return deepFreeze<StandardPoolStrategyNode>({
    type: 'harness:pool-strategy',
    id: `${poolId}:round-robin`,
    strategyKind: 'round-robin',
  });
}
