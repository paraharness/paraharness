import type PQueue from 'p-queue';
import type { FileLockLease } from '../file-lock-lease.js';
import type { ResolvedFileLockOptions } from './resolved-file-lock-options.js';

/**
 * Parameter object for `executeQueuedLockSlot`.
 *
 * Bundles the per-path `PQueue`, canonical lockfile path, normalized options, and lease promise
 * settlement callbacks so `executeQueuedLockSlot` adheres to the `<= 3` parameter limit.
 */
export interface ExecuteQueuedLockSlotParams {
  /** Single-concurrency FIFO queue dedicated to `resolvedLockPath`. */
  readonly queue: PQueue;
  /** Canonical absolute path of the lockfile on disk. */
  readonly resolvedLockPath: string;
  /** Normalized timeout, stale threshold, heartbeat interval, and retry settings. */
  readonly resolvedOptions: ResolvedFileLockOptions;
  /** Callback resolving the caller's lease promise once the disk lock is acquired. */
  readonly resolveLease: (lease: FileLockLease) => void;
  /** Callback rejecting the caller's lease promise if disk lock acquisition fails. */
  readonly rejectLease: (error: unknown) => void;
}
