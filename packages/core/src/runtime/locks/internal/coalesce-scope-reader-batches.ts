import type {
  ScopeLockEntryState,
  ScopeLockQueuedTurn,
  ScopeLockReaderBatchState,
} from '../scope-lock-entry-state.js';

/**
 * Removes `target` from `entry.queuedTurns` if still present and updates `entry.pendingWriters`.
 *
 * Guarantees idempotent removal when a queued turn either starts executing in `PQueue` or
 * aborts via `AbortSignal` before reaching the front of the queue.
 *
 * @param {ScopeLockEntryState}                             entry  - Lock state record for the target handle.
 * @param {ScopeLockQueuedTurn | ScopeLockReaderBatchState} target - Queued turn or reader batch to remove.
 */
export function removeScopeQueuedTurn(
  entry: ScopeLockEntryState,
  target: ScopeLockQueuedTurn | ScopeLockReaderBatchState,
): void {
  for (let index = 0; index < entry.queuedTurns.length; index += 1) {
    const queuedTurn = entry.queuedTurns[index];
    if (queuedTurn !== target && queuedTurn?.batch !== target) continue;
    entry.queuedTurns.splice(index, 1);
    if (queuedTurn.kind === 'writer') {
      entry.pendingWriters = Math.max(0, entry.pendingWriters - 1);
    }
    return;
  }
}

/**
 * Promotes leading queued reader batches into `entry.activeReaderBatch` when no writer blocks them.
 *
 * Invoked after a queued writer aborts while an earlier reader batch is still active so
 * queued readers behind the aborted writer immediately join the active shared-read batch.
 *
 * @param {ScopeLockEntryState} entry - Lock state record for the target handle.
 */
export function promoteLeadingReadersToActiveBatch(entry: ScopeLockEntryState): void {
  const activeBatch = entry.activeReaderBatch;
  if (entry.writerActive || activeBatch === undefined) return;
  while (entry.queuedTurns[0]?.kind === 'readers') {
    const leadingTurn = entry.queuedTurns.shift();
    const leadingBatch = leadingTurn?.batch;
    if (leadingBatch === undefined) continue;
    leadingBatch.waitController.abort();
    for (const waiter of leadingBatch.waiters) {
      leadingBatch.waiters.delete(waiter);
      waiter.batch = activeBatch;
      waiter.grant(activeBatch);
    }
  }
}

/**
 * Coalesces any adjacent queued reader batches in `entry.queuedTurns` into a single batch turn.
 *
 * Moves waiters from each trailing adjacent reader batch into its preceding reader batch
 * and aborts the trailing batch's queued `PQueue` job so all coalesced readers wake together.
 *
 * @param {ScopeLockEntryState} entry - Lock state record for the target handle.
 */
export function coalesceAdjacentQueuedReaderBatches(entry: ScopeLockEntryState): void {
  let index = 0;
  while (index + 1 < entry.queuedTurns.length) {
    const earlierBatch = entry.queuedTurns[index]?.batch;
    const laterBatch = entry.queuedTurns[index + 1]?.batch;
    if (earlierBatch === undefined || laterBatch === undefined) {
      index += 1;
      continue;
    }
    entry.queuedTurns.splice(index + 1, 1);
    laterBatch.waitController.abort();
    for (const waiter of laterBatch.waiters) {
      laterBatch.waiters.delete(waiter);
      waiter.batch = earlierBatch;
      earlierBatch.waiters.add(waiter);
    }
  }
}

/**
 * Reconciles `entry.queuedTurns` and `entry.openReaderBatch` after a queued turn aborts.
 *
 * Promotes leading queued readers into an active reader batch, coalesces adjacent queued
 * reader batches, and updates `entry.openReaderBatch` from the new queue tail.
 *
 * @param {ScopeLockEntryState} entry - Lock state record for the target handle.
 */
export function reconcileScopeQueuedTurns(entry: ScopeLockEntryState): void {
  promoteLeadingReadersToActiveBatch(entry);
  coalesceAdjacentQueuedReaderBatches(entry);
  const tailTurn = entry.queuedTurns[entry.queuedTurns.length - 1];
  if (tailTurn !== undefined) {
    entry.openReaderBatch = tailTurn.kind === 'readers' ? tailTurn.batch : undefined;
    return;
  }
  entry.openReaderBatch = !entry.writerActive ? entry.activeReaderBatch : undefined;
}
