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
 * Creates a pure, stateless `PoolStrategyBuilder<TItem>` configurator bound to `poolId`.
 *
 * Exposes `.escalateOnRetry()` and `.custom(...)` sub-builders without mutating outer closure variables.
 *
 * @template TItem Pool item type.
 *
 * @param {string} poolId - Owning pool identifier.
 *
 * @returns {PoolStrategyBuilder<TItem>} Frozen `PoolStrategyBuilder` configurator instance.
 */
function createPoolStrategyBuilder<TItem>(poolId: string): PoolStrategyBuilder<TItem> {
  return Object.freeze<PoolStrategyBuilder<TItem>>({
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
  });
}

/**
 * Type guard verifying whether an unknown callback return value is a `PoolStrategyNode` or `AstBuilder<PoolStrategyNode>`.
 *
 * Distinguishes configurator callbacks (`$ => $.escalateOnRetry()`) from 1-argument `PoolSelectorFn` callbacks.
 *
 * @template TItem Pool item type.
 *
 * @param {unknown} value - Candidate return value from a 0- or 1-argument strategy callback.
 *
 * @returns {value is MaybeBuilder<PoolStrategyNode<TItem>>} True when `value` is a pool strategy node or builder.
 */
function isPoolStrategyArtifact<TItem>(
  value: unknown,
): value is MaybeBuilder<PoolStrategyNode<TItem>> {
  return (
    typeof value === 'object' &&
    value !== null &&
    (('toAST' in value && typeof value.toAST === 'function') ||
      ('type' in value && value.type === 'harness:pool-strategy'))
  );
}

/**
 * Attempts to evaluate a 0- or 1-argument function as a `PoolStrategyBuilder` configurator callback.
 *
 * Returns the compiled `PoolStrategyNode<TItem>` when the callback returns a strategy builder or node,
 * or `undefined` when the callback behaves as a direct `PoolSelectorFn<TItem>`.
 *
 * @template TItem Pool item type.
 *
 * @param {string}                                                                   poolId   - Owning pool identifier.
 * @param {($: PoolStrategyBuilder<TItem>) => MaybeBuilder<PoolStrategyNode<TItem>>} callback - Candidate configurator callback.
 *
 * @returns {PoolStrategyNode<TItem> | undefined} Compiled strategy node, or `undefined` if `callback` is a selector function.
 */
function tryResolveConfiguratorStrategy<TItem>(
  poolId: string,
  callback: ($: PoolStrategyBuilder<TItem>) => MaybeBuilder<PoolStrategyNode<TItem>>,
): PoolStrategyNode<TItem> | undefined {
  try {
    const built = callback(createPoolStrategyBuilder<TItem>(poolId));
    return isPoolStrategyArtifact<TItem>(built) ? extractAST(built) : undefined;
  } catch {
    return undefined;
  }
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
