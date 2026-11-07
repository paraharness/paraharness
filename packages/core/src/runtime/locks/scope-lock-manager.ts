import PQueue from 'p-queue';
import {
  createScopeReadLeaseReleaser,
  enqueueScopeReaderBatchTurn,
  enqueueScopeWriterTurn,
  evictIdleScopeLockEntry,
} from './internal/schedule-scope-lock-turn.js';
import type { ScopeLockEntryState, ScopeLockQueueWaiter } from './scope-lock-entry-state.js';

/**
 * Per-handle asynchronous shared-read / exclusive-write lock manager (`SPEC.md` §3.7.2).
 *
 * Allows multiple concurrent shared-read operations (`forkChild`, `inspect`, non-mutating tools)
 * on a scope handle while serializing exclusive-write operations (`commitChild`, `syncChild`,
 * `syncRoot`, mutating tools, and post-flight subprocess tools) via `PQueue` (`concurrency: 1`)
 * with writer-preference fairness and `AbortSignal` support.
 */
export class ScopeLockManager {
  /** Active lock state entries indexed by isolation scope handle reference. */
  private readonly entries = new Map<unknown, ScopeLockEntryState>();

  /**
   * Acquires a shared read lease on `handle`, waiting if an exclusive writer is active or queued.
   *
   * Multiple concurrent callers may hold read leases simultaneously so long as no writer is
   * active or waiting ahead of them in the handle's `PQueue`.
   *
   * @param {unknown}     handle   - Isolation scope handle to lock for shared reading.
   * @param {AbortSignal} [signal] - Optional abort signal cancelling a queued read wait.
   *
   * @returns {Promise<() => void>} Resolves to an idempotent release function.
   */
  acquireRead(handle: unknown, signal?: AbortSignal): Promise<() => void> {
    signal?.throwIfAborted();
    const entry = this.getOrCreateEntry(handle);
    let batch = entry.openReaderBatch;
    if (batch === undefined && !entry.writerActive && entry.pendingWriters === 0 && entry.activeReaderBatch !== undefined) {
      batch = entry.activeReaderBatch;
      entry.openReaderBatch = batch;
    }
    if (batch === undefined) {
      batch = enqueueScopeReaderBatchTurn(this.entries, entry);
    }
    const targetBatch = batch;
    if (targetBatch.started) {
      targetBatch.activeCount += 1;
      entry.activeReaders += 1;
      return Promise.resolve(createScopeReadLeaseReleaser(this.entries, entry, targetBatch));
    }
    return new Promise<() => void>((resolve, reject) => {
      let onAbort: (() => void) | undefined;
      const waiter: ScopeLockQueueWaiter = {
        grant: (): void => {
          if (onAbort !== undefined && signal !== undefined) signal.removeEventListener('abort', onAbort);
          targetBatch.activeCount += 1;
          entry.activeReaders += 1;
          resolve(createScopeReadLeaseReleaser(this.entries, entry, targetBatch));
        },
      };
      if (signal !== undefined) {
        onAbort = (): void => {
          targetBatch.waiters.delete(waiter);
          if (targetBatch.waiters.size === 0 && !targetBatch.started) {
            if (entry.openReaderBatch === targetBatch) entry.openReaderBatch = undefined;
            targetBatch.waitController.abort(signal.reason);
          }
          evictIdleScopeLockEntry(this.entries, entry);
          reject(signal.reason);
        };
        signal.addEventListener('abort', onAbort, { once: true });
      }
      targetBatch.waiters.add(waiter);
    });
  }

  /**
   * Acquires an exclusive write lease on `handle`, waiting until all prior readers and writers release.
   *
   * Seals the current reader batch for writer-preference fairness and guarantees that zero other
   * readers or writers hold a lease on `handle` while the returned lease remains unreleased.
   *
   * @param {unknown}     handle   - Isolation scope handle to lock for exclusive writing.
   * @param {AbortSignal} [signal] - Optional abort signal cancelling a queued write wait.
   *
   * @returns {Promise<() => void>} Resolves to an idempotent release function.
   */
  acquireWrite(handle: unknown, signal?: AbortSignal): Promise<() => void> {
    signal?.throwIfAborted();
    const entry = this.getOrCreateEntry(handle);
    return enqueueScopeWriterTurn(this.entries, entry, signal);
  }

  /**
   * Executes `work` while holding a shared read lease on `handle` and releases the lease in `finally`.
   *
   * Guarantees deterministic lease cleanup and idle entry eviction even when `work` throws or rejects.
   *
   * @template TResult Return type of `work`.
   *
   * @param {unknown}                          handle   - Isolation scope handle to guard with a read lease.
   * @param {() => Promise<TResult> | TResult} work     - Callback executed under the shared read lease.
   * @param {AbortSignal}                      [signal] - Optional abort signal cancelling lock wait.
   *
   * @returns {Promise<TResult>} Result produced by `work`.
   */
  async withReadLock<TResult>(
    handle: unknown,
    work: () => Promise<TResult> | TResult,
    signal?: AbortSignal,
  ): Promise<TResult> {
    const release = await this.acquireRead(handle, signal);
    try {
      return await work();
    } finally {
      release();
      await Promise.resolve();
      await Promise.resolve();
    }
  }

  /**
   * Executes `work` while holding an exclusive write lease on `handle` and releases the lease in `finally`.
   *
   * Guarantees deterministic lease cleanup and idle entry eviction even when `work` throws or rejects.
   *
   * @template TResult Return type of `work`.
   *
   * @param {unknown}                          handle   - Isolation scope handle to guard with a write lease.
   * @param {() => Promise<TResult> | TResult} work     - Callback executed under the exclusive write lease.
   * @param {AbortSignal}                      [signal] - Optional abort signal cancelling lock wait.
   *
   * @returns {Promise<TResult>} Result produced by `work`.
   */
  async withWriteLock<TResult>(
    handle: unknown,
    work: () => Promise<TResult> | TResult,
    signal?: AbortSignal,
  ): Promise<TResult> {
    const release = await this.acquireWrite(handle, signal);
    try {
      return await work();
    } finally {
      release();
      await Promise.resolve();
      await Promise.resolve();
    }
  }

  /**
   * Checks whether `handle` currently holds an active exclusive write lease.
   *
   * Used by runtime invariants and tests to verify exclusive-write serialization on scope handles.
   *
   * @param {unknown} handle - Isolation scope handle to inspect.
   *
   * @returns {boolean} True when an exclusive writer currently holds `handle`.
   */
  isWriteLocked(handle: unknown): boolean {
    return this.entries.get(handle)?.writerActive === true;
  }

  /**
   * Checks whether `handle` currently has a tracked lock state entry in `this.entries`.
   *
   * Returns `false` once `activeReaders === 0 && !writerActive && queue.size === 0 && queue.pending === 0`.
   *
   * @param {unknown} handle - Isolation scope handle to inspect.
   *
   * @returns {boolean} True when a non-evicted lock entry exists for `handle`.
   */
  hasLockEntry(handle: unknown): boolean {
    return this.entries.has(handle);
  }

  /**
   * Looks up or initializes the mutable lock state entry for `handle`.
   *
   * Creates a fresh unlocked entry backed by `PQueue({ concurrency: 1 })` when `handle` is not tracked.
   *
   * @param {unknown} handle - Isolation scope handle key.
   *
   * @returns {ScopeLockEntryState} Existing or newly initialized lock state entry.
   */
  private getOrCreateEntry(handle: unknown): ScopeLockEntryState {
    const existing = this.entries.get(handle);
    if (existing !== undefined) {
      return existing;
    }
    const queue = new PQueue({ concurrency: 1 });
    const created: ScopeLockEntryState = {
      handle,
      queue,
      activeReaders: 0,
      writerActive: false,
      pendingWriters: 0,
      activeReaderBatch: undefined,
      openReaderBatch: undefined,
    };
    queue.on('idle', () => {
      evictIdleScopeLockEntry(this.entries, created);
    });
    this.entries.set(handle, created);
    return created;
  }
}
