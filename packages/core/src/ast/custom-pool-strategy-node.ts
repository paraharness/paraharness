import type { ASTNode } from './ast-node.js';
import type { PoolCandidateState } from './pool-candidate-state.js';
import type { PoolSelectionContext } from './pool-selection-context.js';

/**
 * Passive AST node for user-supplied custom pool selector functions.
 *
 * Stores the synchronous selector callback invoked by the runtime pool scheduler to choose a candidate.
 *
 * @template TItem Pooled resource item type.
 */
export interface CustomPoolStrategyNode<TItem = unknown> extends ASTNode {
  /** Discriminant identifying a pool selection strategy node. */
  readonly type: 'harness:pool-strategy';
  /** Unique identifier of the strategy configuration. */
  readonly id: string;
  /** Custom selector strategy kind. */
  readonly strategyKind: 'custom';
  /** Synchronous selector callback invoked to pick a candidate from the pool. */
  readonly selectFn: (
    candidates: readonly PoolCandidateState<TItem>[],
    ctx: PoolSelectionContext,
  ) => TItem | undefined;
}
