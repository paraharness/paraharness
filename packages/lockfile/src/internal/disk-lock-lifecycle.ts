import { randomUUID } from 'node:crypto';
import { mkdir, utimes } from 'node:fs/promises';
import path from 'node:path';
import PQueue from 'p-queue';
import type { FileLockLease } from '../file-lock-lease.js';
import type { FileLockOptions } from '../file-lock-options.js';
import {
  DEFAULT_LOCK_HEARTBEAT_INTERVAL_MS,
  DEFAULT_LOCK_RETRY_DELAY_MS,
  DEFAULT_LOCK_STALE_MS,
  DEFAULT_LOCK_TIMEOUT_MS,
  LOCK_PATH_QUEUES,
} from '../file-lock.constants.js';
import type { CreateHeartbeatLeaseParams } from './create-heartbeat-lease-params.js';
import type { ResolvedFileLockOptions } from './resolved-file-lock-options.js';
import {
  isExistingLockStale,
  tryReclaimStaleLock,
  tryWriteExclusiveLockFile,
  unlinkOwnedLockFile,
} from './stale-lock-helpers.js';

/**
 * Normalizes optional caller lock configuration by filling in default timing constants.
 *
 * Ensures positive defaults for timeout, stale expiration, heartbeat cadence, and retry backoff.
 *
 * @param {FileLockOptions} [options] - Optional caller-supplied lock timing overrides.
 *
 * @returns {ResolvedFileLockOptions} Complete lock options object with all defaults resolved.
 */
export function resolveFileLockOptions(options?: FileLockOptions): ResolvedFileLockOptions {
  return {
    timeoutMs: options?.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS,
    staleMs: options?.staleMs ?? DEFAULT_LOCK_STALE_MS,
    heartbeatIntervalMs: options?.heartbeatIntervalMs ?? DEFAULT_LOCK_HEARTBEAT_INTERVAL_MS,
    retryDelayMs: options?.retryDelayMs ?? DEFAULT_LOCK_RETRY_DELAY_MS,
    signal: options?.signal,
  };
}

/**
 * Evicts `queue` from `LOCK_PATH_QUEUES` when it has no queued or running tasks remaining.
 *
 * Keeps the module-level `LOCK_PATH_QUEUES` map bounded across transient lockfile paths.
 *
 * @param {string} resolvedLockPath - Canonical absolute path of the lockfile.
 * @param {PQueue} queue            - Queue instance associated with `resolvedLockPath`.
 */
export function evictIdleLockQueue(resolvedLockPath: string, queue: PQueue): void {
  if (
    queue.size === 0 &&
    queue.pending === 0 &&
    LOCK_PATH_QUEUES.get(resolvedLockPath) === queue
  ) {
    LOCK_PATH_QUEUES.delete(resolvedLockPath);
  }
}

/**
 * Retrieves or initializes the in-process `PQueue` (`concurrency: 1`) for a canonical lockfile path.
 *
 * Serializes same-process lock acquisitions in FIFO order before touching the filesystem and evicts
 * the queue entry from `LOCK_PATH_QUEUES` once it becomes idle.
 *
 * @param {string} resolvedLockPath - Canonical absolute path of the target lockfile.
 *
 * @returns {PQueue} Single-concurrency FIFO queue dedicated to `resolvedLockPath`.
 */
export function getOrCreateLockQueue(resolvedLockPath: string): PQueue {
  const existingQueue = LOCK_PATH_QUEUES.get(resolvedLockPath);
  if (existingQueue !== undefined) return existingQueue;
  const createdQueue = new PQueue({ concurrency: 1 });
  createdQueue.on('idle', () => {
    evictIdleLockQueue(resolvedLockPath, createdQueue);
  });
  LOCK_PATH_QUEUES.set(resolvedLockPath, createdQueue);
  return createdQueue;
}

/**
 * Acquires the on-disk lockfile via atomic `open(..., 'wx')` creation or stale-lock reclamation.
 *
 * Polls on `EEXIST` until `options.timeoutMs` elapses, reclaiming the lockfile atomically if its holder
 * process died (`ESRCH`) or its `mtime` heartbeat exceeded `options.staleMs`.
 *
 * @param {string}                  resolvedLockPath - Canonical absolute path of the lockfile.
 * @param {ResolvedFileLockOptions} options          - Normalized timeout, stale, and retry settings.
 *
 * @returns {Promise<string>} Unique `ownerToken` written to the acquired lockfile.
 *
 * @throws {Error} If the lock cannot be acquired within `options.timeoutMs` or an unexpected filesystem error occurs.
 */
export async function acquireDiskFileLock(
  resolvedLockPath: string,
  options: ResolvedFileLockOptions,
): Promise<string> {
  options.signal?.throwIfAborted();
  await mkdir(path.dirname(resolvedLockPath), { recursive: true });
  const ownerToken = `${process.pid}:${Date.now()}:${randomUUID()}`;
  const startMs = Date.now();
  while (true) {
    options.signal?.throwIfAborted();
    const payload = JSON.stringify({ pid: process.pid, acquiredAtMs: Date.now(), ownerToken });
    if (await tryWriteExclusiveLockFile(resolvedLockPath, payload)) {
      return ownerToken;
    }
    if (
      (await isExistingLockStale(resolvedLockPath, options.staleMs)) &&
      (await tryReclaimStaleLock(resolvedLockPath, payload, options.staleMs))
    ) {
      return ownerToken;
    }
    if (Date.now() - startMs >= options.timeoutMs) {
      throw new Error(`Timed out after ${options.timeoutMs}ms waiting for file lock '${resolvedLockPath}'.`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, options.retryDelayMs));
  }
}

/**
 * Starts a periodic `.unref()`ed `utimes` heartbeat for an acquired lockfile and returns its `FileLockLease`.
 *
 * On `release()`, cancels the interval timer, awaits any in-flight heartbeat write before unlinking
 * `resolvedLockPath` when still owned by `ownerToken`, and awaits `onReleased` to unblock the `PQueue` slot.
 *
 * @param {CreateHeartbeatLeaseParams} params - Lock path, owner token, heartbeat interval, and release callback.
 *
 * @returns {FileLockLease} Frozen lease handle exposing `lockPath`, `ownerToken`, and idempotent `release()`.
 */
export function createHeartbeatLease(params: CreateHeartbeatLeaseParams): FileLockLease {
  let released = false;
  let inFlightHeartbeat: Promise<void> | undefined;
  let releasePromise: Promise<void> | undefined;
  const timer = setInterval(() => {
    if (released || inFlightHeartbeat !== undefined) return;
    const now = new Date();
    inFlightHeartbeat = utimes(params.resolvedLockPath, now, now)
      .catch(() => undefined)
      .finally(() => {
        inFlightHeartbeat = undefined;
      });
  }, params.heartbeatIntervalMs);
  timer.unref();
  return Object.freeze<FileLockLease>({
    lockPath: params.resolvedLockPath,
    ownerToken: params.ownerToken,
    release(): Promise<void> {
      if (releasePromise !== undefined) return releasePromise;
      released = true;
      clearInterval(timer);
      releasePromise = (async (): Promise<void> => {
        try {
          if (inFlightHeartbeat !== undefined) await inFlightHeartbeat;
          await unlinkOwnedLockFile(params.resolvedLockPath, params.ownerToken);
        } finally {
          await params.onReleased();
        }
      })();
      return releasePromise;
    },
  });
}

/**
 * Acquires the on-disk lockfile inside a reserved `PQueue` slot, resolves `resolveLease` with the
 * active `FileLockLease`, and holds the queue slot open until `lease.release()` completes.
 *
 * @param {PQueue}                         queue            - Single-concurrency queue for `resolvedLockPath`.
 * @param {string}                         resolvedLockPath - Canonical absolute path of the lockfile.
 * @param {ResolvedFileLockOptions}        resolvedOptions  - Normalized timeout, stale, and heartbeat settings.
 * @param {(lease: FileLockLease) => void} resolveLease     - Callback resolving the caller's lease promise.
 * @param {(error: unknown) => void}       rejectLease      - Callback rejecting the caller's lease promise on failure.
 *
 * @returns {Promise<void>} Resolves once the lease is released or acquisition fails.
 */
export async function executeQueuedLockSlot(
  queue: PQueue,
  resolvedLockPath: string,
  resolvedOptions: ResolvedFileLockOptions,
  resolveLease: (lease: FileLockLease) => void,
  rejectLease: (error: unknown) => void,
): Promise<void> {
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
}
