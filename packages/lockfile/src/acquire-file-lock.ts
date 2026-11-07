import path from 'node:path';
import type { FileLockLease } from './file-lock-lease.js';
import type { FileLockOptions } from './file-lock-options.js';
import {
  acquireDiskFileLock,
  createHeartbeatLease,
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
 * @param {FileLockOptions} [options] - Optional timeout, stale threshold, heartbeat, and retry settings.
 *
 * @returns {Promise<FileLockLease>} Active lock lease whose `release()` method frees both the disk lock and queue slot.
 *
 * @throws {Error} If `lockPath` is empty or the lock cannot be acquired within `options.timeoutMs`.
 */
export function acquireFileLock(lockPath: string, options?: FileLockOptions): Promise<FileLockLease> {
  if (lockPath.trim().length === 0) {
    return Promise.reject(new Error('acquireFileLock requires a non-empty lockPath.'));
  }
  const resolvedLockPath = path.resolve(lockPath);
  const resolvedOptions = resolveFileLockOptions(options);
  const queue = getOrCreateLockQueue(resolvedLockPath);
  return new Promise<FileLockLease>((resolveLease, rejectLease) => {
    void queue.add(async () => {
      let releaseQueueSlot: (() => void) | undefined;
      const queueSlotReleased = new Promise<void>((resolveSlot) => {
        releaseQueueSlot = resolveSlot;
      });
      try {
        const ownerToken = await acquireDiskFileLock(resolvedLockPath, resolvedOptions);
        const lease = createHeartbeatLease({
          resolvedLockPath,
          ownerToken,
          heartbeatIntervalMs: resolvedOptions.heartbeatIntervalMs,
          onReleased: () =>
            new Promise<void>((resolveReleased) => {
              queue.once('next', () => resolveReleased());
              releaseQueueSlot?.();
            }),
        });
        resolveLease(lease);
        await queueSlotReleased;
      } catch (error: unknown) {
        queue.once('next', () => rejectLease(error));
      }
    });
  });
}
