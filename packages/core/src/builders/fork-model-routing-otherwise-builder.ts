import type { MaybeBuilder } from '../ast/ast-foundation.types.js';
import type { ModelASTNode } from '../ast/domain-ast.types.js';
import type { ForkModelRoutingConfig } from '../ast/fork-capability-node.js';
import type { PoolNode } from '../ast/pool-node.js';

/**
 * Terminal sub-builder interface for downward fork model routing after `.inheritParentWithEffort(...)`.
 *
 * Requires `.otherwisePool(modelOrPool)` before compiling into a `ForkModelRoutingConfig`.
 *
 * @template TParentIn Parent actor input payload type.
 * @template TReq      Fork tool call request payload type.
 */
export interface ForkModelRoutingOtherwiseBuilder<TParentIn = unknown, TReq = unknown> {
  /**
   * Binds the fallback model or model pool used when `inheritParentWithEffort` is not matched.
   *
   * Completes the conditional model routing rule for the forked child session.
   *
   * @param {MaybeBuilder<ModelASTNode> | MaybeBuilder<PoolNode<ModelASTNode>>} modelOrPool - Fallback model or pool AST node.
   *
   * @returns {ForkModelRoutingOtherwiseBuilder<TParentIn, TReq>} New immutable model routing builder.
   */
  otherwisePool(
    modelOrPool: MaybeBuilder<ModelASTNode> | MaybeBuilder<PoolNode<ModelASTNode>>,
  ): ForkModelRoutingOtherwiseBuilder<TParentIn, TReq>;

  /**
   * Compiles the model routing configuration into a frozen `ForkModelRoutingConfig`.
   *
   * Validates that both `.inheritParentWithEffort(...)` and `.otherwisePool(...)` have been configured.
   *
   * @returns {ForkModelRoutingConfig<TParentIn, TReq>} Deeply frozen fork model routing configuration.
   */
  toAST(): ForkModelRoutingConfig<TParentIn, TReq>;
}
