import type { ScopeLockEntryState } from '../scope-lock-entry-state.js';

/**
 * Advances the FIFO wait queue for a scope handle after a read or write lease is released.
 *
 * Grants the next pending exclusive writer when zero readers are active, or wakes all
 * contiguous leading shared readers up to the first queued writer to prevent writer starvation.
 *
 * @param {Map<unknown, ScopeLockEntryState>} entries - Active lock state map keyed by scope handle.
 * @param {ScopeLockEntryState}               entry   - Lock state record for the target handle.
 */
export function drainScopeLockQueue(
  entries: Map<unknown, ScopeLockEntryState>,
  entry: ScopeLockEntryState,
): void {
  if (entry.activeWriter) {
    return;
  }
  const head = entry.waitQueue[0];
  if (head === undefined) {
    if (entry.activeReaders === 0) {
      entries.delete(entry.handle);
    }
    return;
  }
  if (head.mode === 'write') {
    if (entry.activeReaders === 0) {
      entry.waitQueue.shift();
      entry.activeWriter = true;
      head.grant();
    }
    return;
  }
  while (entry.waitQueue[0]?.mode === 'read') {
    const readerWaiter = entry.waitQueue.shift();
    if (readerWaiter !== undefined) {
      entry.activeReaders += 1;
      readerWaiter.grant();
    }
  }
}

/**
 * Creates an idempotent release function for a granted read or write scope lock lease.
 *
 * Ensures that invoking the returned release callback multiple times decrements the active
 * lease state at most once before draining the handle's pending wait queue.
 *
 * @param {Map<unknown, ScopeLockEntryState>} entries - Active lock state map keyed by scope handle.
 * @param {ScopeLockEntryState}               entry   - Lock state record for the target handle.
 * @param {'read' | 'write'}                  mode    - Lease mode being released.
 *
 * @returns {() => void} Idempotent release callback.
 */
export function createScopeLeaseReleaser(
  entries: Map<unknown, ScopeLockEntryState>,
  entry: ScopeLockEntryState,
  mode: 'read' | 'write',
): () => void {
  let released = false;
  return (): void => {
    if (released) {
      return;
    }
    released = true;
    if (mode === 'write') {
      entry.activeWriter = false;
    } else {
      entry.activeReaders = Math.max(0, entry.activeReaders - 1);
    }
    drainScopeLockQueue(entries, entry);
  };
}
