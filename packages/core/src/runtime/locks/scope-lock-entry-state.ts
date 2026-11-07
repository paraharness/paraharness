import type PQueue from 'p-queue';

/**
 * Queued shared-read waiter entry inside a `ScopeLockReaderBatchState`.
 *
 * Stores the continuation callback invoked when the enclosing reader batch turn starts in `PQueue`.
 */
export interface ScopeLockQueueWaiter {
  /** Synchronous callback that resolves the reader's acquisition promise with its release handle. */
  readonly grant: () => void;
}

/**
 * Reader-batch turn state coordinated on a handle's `PQueue` (`concurrency: 1`).
 *
 * Groups concurrent shared-read callers that arrive while no exclusive writer is queued after
 * the batch, holding a single `PQueue` concurrency slot until all readers in the batch release.
 */
export interface ScopeLockReaderBatchState {
  /** True once the `PQueue` turn for this reader batch has begun executing. */
  started: boolean;
  /** Count of currently active (granted and unreleased) readers belonging to this batch. */
  activeCount: number;
  /** Controller used to cancel the queued `PQueue` turn if all waiters abort before the batch starts. */
  readonly waitController: AbortController;
  /** Set of pending reader waiters awaiting the start of this batch turn in `PQueue`. */
  readonly waiters: Set<ScopeLockQueueWaiter>;
  /** Resolver callback that completes the batch's `PQueue` turn once `activeCount` drops to zero. */
  finishTurn: (() => void) | undefined;
}

/**
 * Per-handle read/write lock state tracked by `ScopeLockManager`.
 *
 * Coordinates exclusive writer turns and shared reader-batch turns via a single-concurrency
 * `PQueue` (`concurrency: 1`) with writer-preference fairness and automatic idle eviction.
 */
export interface ScopeLockEntryState {
  /** Isolation scope handle reference guarded by this lock entry. */
  readonly handle: unknown;
  /** Single-concurrency `PQueue` (`concurrency: 1`) serializing writer turns and reader-batch turns. */
  readonly queue: PQueue;
  /** Number of currently active shared-read leases held on this scope handle. */
  activeReaders: number;
  /** True when an exclusive-write lease is currently held on this scope handle. */
  writerActive: boolean;
  /** Number of exclusive writers currently queued in `queue` awaiting their turn. */
  pendingWriters: number;
  /** Currently executing reader batch occupying the `queue` slot, if any. */
  activeReaderBatch: ScopeLockReaderBatchState | undefined;
  /** Open reader batch accepting new concurrent readers when no writer is queued after it. */
  openReaderBatch: ScopeLockReaderBatchState | undefined;
}
