import { createScopeLeaseReleaser } from './internal/drain-scope-lock-queue.js';
import type { ScopeLockEntryState } from './scope-lock-entry-state.js';

/**
 * Per-handle asynchronous shared-read / exclusive-write lock manager (`SPEC.md` §3.7.2).
 *
 * Allows multiple concurrent shared-read operations (`forkChild`, `inspect`, non-mutating tools)
 * on a scope handle while serializing exclusive-write operations (`commitChild`, `syncChild`,
 * `syncRoot`, mutating tools, and post-flight subprocess tools) in strict FIFO order without writer starvation.
 */
export class ScopeLockManager {
  /** Active lock state entries indexed by isolation scope handle reference. */
  private readonly entries = new Map<unknown, ScopeLockEntryState>();

  /**
   * Acquires a shared read lease on `handle`, waiting if an exclusive writer is active or queued.
   *
   * Multiple concurrent callers may hold read leases simultaneously so long as no writer is
   * active or waiting ahead of them in the FIFO queue.
   *
   * @param {unknown} handle - Isolation scope handle to lock for shared reading.
   *
   * @returns {Promise<() => void>} Resolves to an idempotent release function.
   */
  acquireRead(handle: unknown): Promise<() => void> {
    const entry = this.getOrCreateEntry(handle);
    if (!entry.activeWriter && entry.waitQueue.length === 0) {
      entry.activeReaders += 1;
      return Promise.resolve(createScopeLeaseReleaser(this.entries, entry, 'read'));
    }
    return new Promise<() => void>((resolve) => {
      entry.waitQueue.push({
        mode: 'read',
        grant: (): void => {
          resolve(createScopeLeaseReleaser(this.entries, entry, 'read'));
        },
      });
    });
  }

  /**
   * Acquires an exclusive write lease on `handle`, waiting until all prior readers and writers release.
   *
   * Guarantees that zero other readers or writers hold a lease on `handle` while the returned
   * lease remains unreleased.
   *
   * @param {unknown} handle - Isolation scope handle to lock for exclusive writing.
   *
   * @returns {Promise<() => void>} Resolves to an idempotent release function.
   */
  acquireWrite(handle: unknown): Promise<() => void> {
    const entry = this.getOrCreateEntry(handle);
    if (!entry.activeWriter && entry.activeReaders === 0 && entry.waitQueue.length === 0) {
      entry.activeWriter = true;
      return Promise.resolve(createScopeLeaseReleaser(this.entries, entry, 'write'));
    }
    return new Promise<() => void>((resolve) => {
      entry.waitQueue.push({
        mode: 'write',
        grant: (): void => {
          resolve(createScopeLeaseReleaser(this.entries, entry, 'write'));
        },
      });
    });
  }

  /**
   * Executes `work` while holding a shared read lease on `handle` and releases the lease in `finally`.
   *
   * Guarantees deterministic lease cleanup even when `work` throws synchronously or rejects asynchronously.
   *
   * @template TResult Return type of `work`.
   *
   * @param {unknown}                          handle - Isolation scope handle to guard with a read lease.
   * @param {() => Promise<TResult> | TResult} work   - Callback executed under the shared read lease.
   *
   * @returns {Promise<TResult>} Result produced by `work`.
   */
  async withReadLock<TResult>(
    handle: unknown,
    work: () => Promise<TResult> | TResult,
  ): Promise<TResult> {
    const release = await this.acquireRead(handle);
    try {
      return await work();
    } finally {
      release();
    }
  }

  /**
   * Executes `work` while holding an exclusive write lease on `handle` and releases the lease in `finally`.
   *
   * Guarantees deterministic lease cleanup even when `work` throws synchronously or rejects asynchronously.
   *
   * @template TResult Return type of `work`.
   *
   * @param {unknown}                          handle - Isolation scope handle to guard with a write lease.
   * @param {() => Promise<TResult> | TResult} work   - Callback executed under the exclusive write lease.
   *
   * @returns {Promise<TResult>} Result produced by `work`.
   */
  async withWriteLock<TResult>(
    handle: unknown,
    work: () => Promise<TResult> | TResult,
  ): Promise<TResult> {
    const release = await this.acquireWrite(handle);
    try {
      return await work();
    } finally {
      release();
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
    return this.entries.get(handle)?.activeWriter === true;
  }

  /**
   * Looks up or initializes the mutable lock state entry for `handle`.
   *
   * Creates a fresh unlocked entry when `handle` is not currently tracked in `this.entries`.
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
    const created: ScopeLockEntryState = {
      handle,
      activeReaders: 0,
      activeWriter: false,
      waitQueue: [],
    };
    this.entries.set(handle, created);
    return created;
  }
}
