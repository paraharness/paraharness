import type { ASTNode } from '../ast/ast-node.js';
import type { PoolStrategyNode } from '../ast/pool-strategy.types.js';

/**
 * Optional state parameters for constructing a `PoolBuilder` instance.
 *
 * Holds the immutable candidate items list, compiled `PoolStrategyNode`, and optional
 * fallback item across copy-on-write builder transitions.
 *
 * @template TItem Pool candidate AST node type.
 */
export interface CreatePoolBuilderState<TItem extends ASTNode = ASTNode> {
  /** Candidate items registered in the pool. */
  readonly items?: readonly TItem[];
  /** Selection strategy AST node. */
  readonly strategy?: PoolStrategyNode<TItem>;
  /** Optional fallback item when primary items are exhausted. */
  readonly fallbackItem?: TItem;
}
