import { randomUUID } from 'node:crypto';
import { mkdir, open, unlink, utimes } from 'node:fs/promises';
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
import { isExistingLockStale, readLockRecord, tryReclaimStaleLock } from './stale-lock-helpers.js';

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
  };
}

/**
 * Retrieves or initializes the in-process `PQueue` (`concurrency: 1`) for a canonical lockfile path.
 *
 * Serializes same-process lock acquisitions in FIFO order before touching the filesystem.
 *
 * @param {string} resolvedLockPath - Canonical absolute path of the target lockfile.
 *
 * @returns {PQueue} Single-concurrency FIFO queue dedicated to `resolvedLockPath`.
 */
export function getOrCreateLockQueue(resolvedLockPath: string): PQueue {
  let queue = LOCK_PATH_QUEUES.get(resolvedLockPath);
  if (queue === undefined) {
    queue = new PQueue({ concurrency: 1 });
    LOCK_PATH_QUEUES.set(resolvedLockPath, queue);
  }
  return queue;
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
  await mkdir(path.dirname(resolvedLockPath), { recursive: true });
  const ownerToken = `${process.pid}:${Date.now()}:${randomUUID()}`;
  const startMs = Date.now();
  while (true) {
    const payload = JSON.stringify({ pid: process.pid, acquiredAtMs: Date.now(), ownerToken });
    try {
      const handle = await open(resolvedLockPath, 'wx');
      try {
        await handle.writeFile(payload, 'utf8');
      } finally {
        await handle.close();
      }
      return ownerToken;
    } catch (error: unknown) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
      if (await isExistingLockStale(resolvedLockPath, options.staleMs)) {
        if (await tryReclaimStaleLock(resolvedLockPath, payload, ownerToken)) return ownerToken;
      }
      if (Date.now() - startMs >= options.timeoutMs) {
        throw new Error(`Timed out after ${options.timeoutMs}ms waiting for file lock '${resolvedLockPath}'.`);
      }
      await new Promise<void>((resolve) => setTimeout(resolve, options.retryDelayMs));
    }
  }
}

/**
 * Starts a periodic `.unref()`ed `utimes` heartbeat for an acquired lockfile and returns its `FileLockLease`.
 *
 * On `release()`, cancels the interval timer, awaits any in-flight heartbeat write before unlinking
 * `resolvedLockPath`, and invokes `onReleased` to unblock the next in-process `PQueue` waiter.
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
          const record = await readLockRecord(params.resolvedLockPath);
          if (record === undefined || record.ownerToken === params.ownerToken) {
            await unlink(params.resolvedLockPath).catch(() => undefined);
          }
        } finally {
          params.onReleased();
        }
      })();
      return releasePromise;
    },
  });
}
