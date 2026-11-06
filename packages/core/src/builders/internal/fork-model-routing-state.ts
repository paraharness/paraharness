import type { ModelASTNode } from '../../ast/domain-ast.types.js';
import type { PoolNode } from '../../ast/pool-node.js';

/**
 * Immutable copy-on-write state snapshot backing `ForkModelRoutingBuilder`.
 *
 * Holds the optional conditional parent-model inheritance rule and the fallback
 * model or model pool used when the parent inheritance predicate does not match.
 *
 * @template TParentIn Parent actor input payload type.
 * @template TReq      Validated fork tool call request payload type.
 */
export interface ForkModelRoutingState<TParentIn = unknown, TReq = unknown> {
  /** Optional rule inheriting the parent actor's model with a specified reasoning effort. */
  readonly inheritParentEffort:
    | {
        readonly effort: 'low' | 'medium' | 'high';
        readonly when: (parentInput: TParentIn, req: TReq) => boolean;
      }
    | undefined;
  /** Fallback model or model pool used when `inheritParentEffort` is absent or returns `false`. */
  readonly otherwisePool: ModelASTNode | PoolNode<ModelASTNode> | undefined;
}
