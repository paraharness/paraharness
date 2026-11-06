import type { MaybeBuilder } from '../../ast/ast-foundation.types.js';
import type { ModelASTNode } from '../../ast/domain-ast.types.js';
import { extractAST } from '../../ast/extract-ast.js';
import type { ForkModelRoutingConfig } from '../../ast/fork-capability-node.js';
import type { PoolNode } from '../../ast/pool-node.js';
import type { ForkModelRoutingBuilder } from '../fork-model-routing-builder.js';
import { deepFreeze } from './deep-freeze.js';
import type { ForkModelRoutingState } from './fork-model-routing-state.js';

/**
 * Creates a copy-on-write immutable `ForkModelRoutingBuilder` from an internal state snapshot.
 *
 * Validates that `.otherwisePool(modelOrPool)` is configured before compiling to a deeply
 * frozen `ForkModelRoutingConfig`.
 *
 * @template TParentIn Parent actor input payload type.
 * @template TReq      Fork tool call request payload type.
 *
 * @param {ForkModelRoutingState<TParentIn, TReq>} state - Current model routing state.
 *
 * @returns {ForkModelRoutingBuilder<TParentIn, TReq>} Frozen model routing builder.
 */
export function createForkModelRoutingFromState<TParentIn = unknown, TReq = unknown>(
  state: ForkModelRoutingState<TParentIn, TReq>,
): ForkModelRoutingBuilder<TParentIn, TReq> {
  return Object.freeze<ForkModelRoutingBuilder<TParentIn, TReq>>({
    inheritParentWithEffort(
      effort: 'low' | 'medium' | 'high',
      options: { readonly when: (parentInput: TParentIn, req: TReq) => boolean },
    ): ForkModelRoutingBuilder<TParentIn, TReq> {
      return createForkModelRoutingFromState<TParentIn, TReq>({
        inheritParentEffort: { effort, when: options.when },
        otherwisePool: state.otherwisePool,
      });
    },
    otherwisePool(
      modelOrPool: MaybeBuilder<ModelASTNode> | MaybeBuilder<PoolNode<ModelASTNode>>,
    ): ForkModelRoutingBuilder<TParentIn, TReq> {
      return createForkModelRoutingFromState<TParentIn, TReq>({
        inheritParentEffort: state.inheritParentEffort,
        otherwisePool: extractAST(modelOrPool),
      });
    },
    toAST(): ForkModelRoutingConfig<TParentIn, TReq> {
      if (state.otherwisePool === undefined) {
        throw new Error('Fork modelRouting requires .otherwisePool(modelOrPool).');
      }
      return deepFreeze<ForkModelRoutingConfig<TParentIn, TReq>>({
        inheritParentEffort: state.inheritParentEffort,
        otherwisePool: state.otherwisePool,
      });
    },
  });
}
