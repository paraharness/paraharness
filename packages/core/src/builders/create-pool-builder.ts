import type { MaybeBuilder } from '../ast/ast-foundation.types.js';
import type { ASTNode } from '../ast/ast-node.js';
import { extractAST } from '../ast/extract-ast.js';
import type { PoolNode } from '../ast/pool-node.js';
import type { PoolStrategyNode } from '../ast/pool-strategy-node.js';
import type { PoolSelectorFn } from '../ast/pool-selector.types.js';
import type { CreatePoolBuilderOptions } from './create-pool-builder-state.js';
import { assertNonEmptyIdentifier, deepFreeze } from './internal/deep-freeze.js';
import { resolvePoolStrategy } from './internal/resolve-pool-strategy.js';
import type { PoolBuilder } from './pool-builder.js';
import type { PoolStrategyConfigurator } from './pool-strategy-builder.js';

/**
 * Creates a fluent `PoolBuilder` for `H.pool(id)`.
 *
 * Defaults the selection strategy to `'round-robin'` and validates at `.toAST()` time
 * that at least one candidate item has been registered via `.with(...)`.
 *
 * @template TItem Pool candidate AST node type.
 *
 * @param {string}                          id        - Unique identifier of the pool.
 * @param {CreatePoolBuilderOptions<TItem>} [options] - Optional internal copy-on-write state.
 *
 * @returns {PoolBuilder<TItem>} Frozen `PoolBuilder` instance.
 */
export function createPoolBuilder<TItem extends ASTNode = ASTNode>(
  id: string,
  options?: CreatePoolBuilderOptions<TItem>,
): PoolBuilder<TItem> {
  assertNonEmptyIdentifier('H.pool', id);
  const items: readonly TItem[] = options?.items ?? Object.freeze([]);
  const strategy: PoolStrategyNode<TItem> =
    options?.strategy ??
    deepFreeze<PoolStrategyNode<TItem>>({
      type: 'harness:pool-strategy',
      id: `${id}:round-robin`,
      strategyKind: 'round-robin',
    });
  const fallbackItem: TItem | undefined = options?.fallbackItem;

  return Object.freeze<PoolBuilder<TItem>>({
    id,
    with<TNextItem extends ASTNode>(
      ...nextItems: ReadonlyArray<MaybeBuilder<TNextItem>>
    ): PoolBuilder<TNextItem> {
      const extracted: TNextItem[] = [];
      for (const candidate of nextItems) {
        extracted.push(extractAST(candidate));
      }
      return createPoolBuilder<TNextItem>(id, {
        items: Object.freeze(extracted),
      });
    },
    strategy(
      strategyInput:
        | 'soonest-reset'
        | 'round-robin'
        | 'least-used'
        | PoolStrategyNode<TItem>
        | PoolSelectorFn<TItem>
        | (($: PoolStrategyConfigurator<TItem>) => MaybeBuilder<PoolStrategyNode<TItem>>),
    ): PoolBuilder<TItem> {
      return createPoolBuilder<TItem>(id, {
        items,
        strategy: resolvePoolStrategy(id, strategyInput),
        fallbackItem,
      });
    },
    fallback(item: MaybeBuilder<TItem>): PoolBuilder<TItem> {
      return createPoolBuilder<TItem>(id, {
        items,
        strategy,
        fallbackItem: extractAST(item),
      });
    },
    toAST(): PoolNode<TItem> {
      if (items.length === 0) {
        throw new Error(`Pool '${id}' must register at least one item via .with(...).`);
      }
      return deepFreeze<PoolNode<TItem>>({
        type: 'harness:pool',
        id,
        items,
        strategy,
        fallbackItem,
      });
    },
  });
}
