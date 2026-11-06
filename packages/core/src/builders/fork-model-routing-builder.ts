import type { MaybeBuilder } from '../ast/ast-foundation.types.js';
import type { ModelASTNode } from '../ast/domain-ast.types.js';
import type { ForkModelRoutingConfig } from '../ast/fork-capability-node.js';
import type { PoolNode } from '../ast/pool-node.js';

/**
 * Fluent sub-builder for downward fork model routing (`$f.modelRouting($m => ...)`).
 *
 * Configures conditional inheritance of the parent actor's model when KV-cache break-even
 * predicates hold, falling back to `.otherwisePool(modelOrPool)` otherwise.
 *
 * @template TParentIn Parent actor input payload type.
 * @template TReq      Fork tool call request payload type.
 */
export interface ForkModelRoutingBuilder<TParentIn = unknown, TReq = unknown> {
  /**
   * Inherits the parent actor's model with a specified reasoning effort when `options.when(parentInput, req)` returns `true`.
   *
   * Preserves KV-cache prefix reuse on `'clone-transcript'` or `'shared-prefix-only'` forks when the predicate matches.
   *
   * @param {'low' | 'medium' | 'high'}                                         effort  - Reasoning effort level on the inherited parent model.
   * @param {{ readonly when: (parentInput: TParentIn, req: TReq) => boolean }} options - Break-even predicate evaluated before dispatching the child fork.
   *
   * @returns {ForkModelRoutingBuilder<TParentIn, TReq>} New immutable model routing builder.
   */
  inheritParentWithEffort(
    effort: 'low' | 'medium' | 'high',
    options: { readonly when: (parentInput: TParentIn, req: TReq) => boolean },
  ): ForkModelRoutingBuilder<TParentIn, TReq>;

  /**
   * Binds the fallback model or model pool used when `inheritParentWithEffort` is not matched.
   *
   * Required before `.toAST()` can compile a valid `ForkModelRoutingConfig`.
   *
   * @param {MaybeBuilder<ModelASTNode> | MaybeBuilder<PoolNode<ModelASTNode>>} modelOrPool - Fallback model or pool AST node.
   *
   * @returns {ForkModelRoutingBuilder<TParentIn, TReq>} New immutable model routing builder.
   */
  otherwisePool(
    modelOrPool: MaybeBuilder<ModelASTNode> | MaybeBuilder<PoolNode<ModelASTNode>>,
  ): ForkModelRoutingBuilder<TParentIn, TReq>;

  /**
   * Compiles the model routing configuration into a frozen `ForkModelRoutingConfig`.
   *
   * Throws at builder compilation time if `.inheritParentWithEffort(...)` or `.otherwisePool(...)` is missing.
   *
   * @returns {ForkModelRoutingConfig<TParentIn, TReq>} Deeply frozen fork model routing configuration.
   */
  toAST(): ForkModelRoutingConfig<TParentIn, TReq>;
}
