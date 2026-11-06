/**
 * Queued reader or writer waiter entry inside a `ScopeLockEntryState`.
 *
 * Stores the requested lock acquisition mode (`'read'` vs `'write'`) and the continuation
 * callback invoked when the lock manager grants the lease to this waiter.
 */
export interface ScopeLockQueueWaiter {
  /** Requested lock mode (`'read'` for shared access, `'write'` for exclusive access). */
  readonly mode: 'read' | 'write';
  /** Synchronous callback that resolves the waiter's acquisition promise. */
  readonly grant: () => void;
}

/**
 * Per-handle read/write lock state tracked by `ScopeLockManager`.
 *
 * Maintains the target handle reference, count of concurrent active readers, whether an
 * exclusive writer is active, and the FIFO queue of pending reader and writer waiters.
 */
export interface ScopeLockEntryState {
  /** Isolation scope handle reference guarded by this lock entry. */
  readonly handle: unknown;
  /** Number of currently active shared-read leases held on this scope handle. */
  activeReaders: number;
  /** True when an exclusive-write lease is currently held on this scope handle. */
  activeWriter: boolean;
  /** FIFO wait queue of pending read and write acquisition requests. */
  readonly waitQueue: ScopeLockQueueWaiter[];
}
