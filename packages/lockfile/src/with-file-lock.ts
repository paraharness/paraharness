import { acquireFileLock } from './acquire-file-lock.js';
import type { FileLockOptions } from './file-lock-options.js';

/**
 * Executes an asynchronous `work` callback while holding an exclusive file lock on `lockPath`.
 *
 * Guarantees that the acquired `FileLockLease` is released inside a `finally` block even when `work`
 * throws or rejects.
 *
 * @template T Return value type of `work`.
 *
 * @param {string}           lockPath  - Filesystem path of the lockfile to acquire.
 * @param {() => Promise<T>} work      - Asynchronous critical-section callback to execute under the lock.
 * @param {FileLockOptions}  [options] - Optional timeout, stale threshold, heartbeat, and retry settings.
 *
 * @returns {Promise<T>} Result resolved by `work`.
 */
export async function withFileLock<T>(
  lockPath: string,
  work: () => Promise<T>,
  options?: FileLockOptions,
): Promise<T> {
  const lease = await acquireFileLock(lockPath, options);
  try {
    return await work();
  } finally {
    await lease.release();
  }
}
