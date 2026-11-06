import type { PoolCandidateState } from './pool-candidate-state.js';
import type { PoolSelectionContext } from './pool-selection-context.js';

/**
 * Pure synchronous selector callback for custom capacity pool routing.
 *
 * @template TItem Pooled resource item type.
 */
export type PoolSelectorFn<TItem = unknown> = (
  candidates: readonly PoolCandidateState<TItem>[],
  ctx: PoolSelectionContext,
) => TItem | undefined;
