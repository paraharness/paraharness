import type { ForkBatchEntryRecord } from '../../ports/fork-batch-continuation-frame.js';
import type { ChildForkExecutionOutcome } from './child-fork-execution-outcome.js';

/**
 * Context supplied to `coordinateTurnBatchInterruptBarrier()` when a child fork raises an upward interrupt.
 *
 * Combines the raising child's execution outcome, child scope handle, sibling entries, and sibling handles map.
 *
 * @template THandle Runtime handle type of the active `BranchableScope`.
 */
export interface TurnBatchBarrierContext<THandle = unknown> extends ChildForkExecutionOutcome<unknown> {
  /** Isolated scope handle of the child fork that raised the interrupt. */
  readonly childHandle: THandle;
  /** All fork entries in the current batch. */
  readonly siblingEntries: readonly ForkBatchEntryRecord[];
  /** Map of `forkId` to live child scope handle for active siblings. */
  readonly handlesByForkId: ReadonlyMap<string, THandle>;
}
