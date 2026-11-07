import type {
  ScopeLockEntryState,
  ScopeLockQueueWaiter,
  ScopeLockQueuedTurn,
  ScopeLockReaderBatchState,
} from '../scope-lock-entry-state.js';
import {
  reconcileScopeQueuedTurns,
  removeScopeQueuedTurn,
} from './coalesce-scope-reader-batches.js';

/**
 * Evicts `entry` from `entries` when all active readers, writers, and `PQueue` tasks have drained.
 *
 * Enforces the cleanup invariant `activeReaders === 0 && !writerActive && queue.size === 0 && queue.pending === 0`
 * so released scope handles never leak lock state in memory.
 *
 * @param {Map<unknown, ScopeLockEntryState>} entries - Active lock state map keyed by scope handle.
 * @param {ScopeLockEntryState}               entry   - Candidate lock entry to evict if idle.
 */
export function evictIdleScopeLockEntry(
  entries: Map<unknown, ScopeLockEntryState>,
  entry: ScopeLockEntryState,
): void {
  if (
    entry.activeReaders === 0 &&
    !entry.writerActive &&
    entry.queue.size === 0 &&
    entry.queue.pending === 0 &&
    entries.get(entry.handle) === entry
  ) {
    entries.delete(entry.handle);
  }
}

/**
 * Creates an idempotent release callback for a shared read lease within `batch`.
 *
 * Decrements `batch.activeCount` and `entry.activeReaders` at most once, completing the batch's
 * `PQueue` turn and evicting the lock entry when the last reader in `batch` releases.
 *
 * @param {Map<unknown, ScopeLockEntryState>} entries - Active lock state map keyed by scope handle.
 * @param {ScopeLockEntryState}               entry   - Lock state record for the target handle.
 * @param {ScopeLockReaderBatchState}         batch   - Reader batch owning the granted read lease.
 *
 * @returns {() => void} Idempotent read lease release function.
 */
export function createScopeReadLeaseReleaser(
  entries: Map<unknown, ScopeLockEntryState>,
  entry: ScopeLockEntryState,
  batch: ScopeLockReaderBatchState,
): () => void {
  let released = false;
  return (): void => {
    if (released) return;
    released = true;
    batch.activeCount = Math.max(0, batch.activeCount - 1);
    entry.activeReaders = Math.max(0, entry.activeReaders - 1);
    if (batch.activeCount === 0) {
      if (entry.openReaderBatch === batch) entry.openReaderBatch = undefined;
      if (entry.activeReaderBatch === batch) entry.activeReaderBatch = undefined;
      batch.finishTurn?.();
      evictIdleScopeLockEntry(entries, entry);
    }
  };
}

/**
 * Initializes a new `ScopeLockReaderBatchState` and schedules its shared turn on `entry.queue`.
 *
 * When the batch's turn starts in `PQueue`, marks `batch.started = true` and wakes all
 * queued readers registered in `batch.waiters` concurrently.
 *
 * @param {Map<unknown, ScopeLockEntryState>} entries - Active lock state map keyed by scope handle.
 * @param {ScopeLockEntryState}               entry   - Lock state record for the target handle.
 *
 * @returns {ScopeLockReaderBatchState} Newly created and scheduled reader batch state.
 */
export function enqueueScopeReaderBatchTurn(
  entries: Map<unknown, ScopeLockEntryState>,
  entry: ScopeLockEntryState,
): ScopeLockReaderBatchState {
  const batch: ScopeLockReaderBatchState = {
    started: false,
    activeCount: 0,
    waitController: new AbortController(),
    waiters: new Set<ScopeLockQueueWaiter>(),
    finishTurn: undefined,
  };
  const queuedTurn: ScopeLockQueuedTurn = { kind: 'readers', batch };
  entry.queuedTurns.push(queuedTurn);
  entry.openReaderBatch = batch;
  void entry.queue
    .add(
      () =>
        new Promise<void>((resolveTurn) => {
          removeScopeQueuedTurn(entry, queuedTurn);
          if (batch.waiters.size === 0 && batch.activeCount === 0 && entry.openReaderBatch !== batch) {
            resolveTurn();
            return;
          }
          batch.started = true;
          entry.activeReaderBatch = batch;
          batch.finishTurn = resolveTurn;
          for (const waiter of batch.waiters) {
            batch.waiters.delete(waiter);
            waiter.grant(batch);
          }
        }),
      { signal: batch.waitController.signal },
    )
    .catch(() => {
      evictIdleScopeLockEntry(entries, entry);
    });
  return batch;
}

/**
 * Schedules an exclusive writer turn on `entry.queue` (`concurrency: 1`) with writer-preference fairness.
 *
 * Seals `entry.openReaderBatch` so subsequent readers queue behind this writer, supports
 * `AbortSignal` cancellation while queued, and resolves to an idempotent write lease releaser.
 *
 * @param {Map<unknown, ScopeLockEntryState>} entries  - Active lock state map keyed by scope handle.
 * @param {ScopeLockEntryState}               entry    - Lock state record for the target handle.
 * @param {AbortSignal}                       [signal] - Optional abort signal cancelling the queued wait.
 *
 * @returns {Promise<() => void>} Resolves to an idempotent write lease release callback.
 */
export function enqueueScopeWriterTurn(
  entries: Map<unknown, ScopeLockEntryState>, entry: ScopeLockEntryState, signal?: AbortSignal,
): Promise<() => void> {
  entry.openReaderBatch = undefined;
  entry.pendingWriters += 1;
  const queuedTurn: ScopeLockQueuedTurn = { kind: 'writer', batch: undefined };
  entry.queuedTurns.push(queuedTurn);
  const waitController = new AbortController();
  const onWaitAbort = (): void => {
    removeScopeQueuedTurn(entry, queuedTurn);
    waitController.abort(signal?.reason);
    reconcileScopeQueuedTurns(entry);
  };
  signal?.addEventListener('abort', onWaitAbort, { once: true });
  return new Promise<() => void>((resolveGrant, rejectGrant) => {
    void entry.queue
      .add(() => new Promise<void>((resolveTurn) => {
        signal?.removeEventListener('abort', onWaitAbort);
        removeScopeQueuedTurn(entry, queuedTurn);
        entry.writerActive = true;
        let released = false;
        resolveGrant((): void => {
          if (released) return;
          released = true;
          entry.writerActive = false;
          resolveTurn();
          evictIdleScopeLockEntry(entries, entry);
        });
      }), { signal: waitController.signal })
      .catch((error: unknown) => {
        signal?.removeEventListener('abort', onWaitAbort);
        removeScopeQueuedTurn(entry, queuedTurn);
        evictIdleScopeLockEntry(entries, entry);
        rejectGrant(error);
      });
  });
}
