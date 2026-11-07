import path from 'node:path';
import type { FileLockLease } from './file-lock-lease.js';
import type { FileLockOptions } from './file-lock-options.js';
import {
  evictIdleLockQueue,
  executeQueuedLockSlot,
  getOrCreateLockQueue,
  resolveFileLockOptions,
} from './internal/disk-lock-lifecycle.js';

/**
 * Acquires an exclusive in-process (`PQueue`) and cross-process (`open(..., 'wx')` + heartbeat) lock on `lockPath`.
 *
 * Serializes concurrent callers within the same Node.js process through a per-path `PQueue({ concurrency: 1 })`
 * while coordinating across external OS processes via atomic lockfile creation, periodic `utimes` heartbeats,
 * and automatic stale/dead-PID reclamation.
 *
 * @param {string}          lockPath  - Filesystem path of the lockfile to acquire.
 * @param {FileLockOptions} [options] - Optional timeout, stale threshold, heartbeat, retry, and abort settings.
 *
 * @returns {Promise<FileLockLease>} Active lock lease whose `release()` method frees both the disk lock and queue slot.
 *
 * @throws {Error} If `lockPath` is empty, `options.signal` is aborted while waiting, or the lock times out.
 */
export function acquireFileLock(lockPath: string, options?: FileLockOptions): Promise<FileLockLease> {
  if (lockPath.trim().length === 0) {
    return Promise.reject(new Error('acquireFileLock requires a non-empty lockPath.'));
  }
  if (options?.signal?.aborted) {
    return Promise.reject(
      options.signal.reason instanceof Error
        ? options.signal.reason
        : new Error(`Aborted waiting for file lock '${lockPath}'.`),
    );
  }
  const resolvedLockPath = path.resolve(lockPath);
  const resolvedOptions = resolveFileLockOptions(options);
  const queue = getOrCreateLockQueue(resolvedLockPath);
  const waitController = new AbortController();
  const callerSignal = resolvedOptions.signal;
  const onCallerAbort = (): void => {
    waitController.abort(callerSignal?.reason);
  };
  callerSignal?.addEventListener('abort', onCallerAbort, { once: true });
  return new Promise<FileLockLease>((resolveLease, rejectLease) => {
    void queue
      .add(
        async () => {
          callerSignal?.removeEventListener('abort', onCallerAbort);
          await executeQueuedLockSlot(queue, resolvedLockPath, resolvedOptions, resolveLease, rejectLease);
        },
        { signal: waitController.signal },
      )
      .catch((error: unknown) => {
        callerSignal?.removeEventListener('abort', onCallerAbort);
        evictIdleLockQueue(resolvedLockPath, queue);
        rejectLease(error);
      });
  });
}
