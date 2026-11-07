import { open, readFile, stat, unlink } from 'node:fs/promises';
import type { FileLockRecord } from './file-lock-record.js';

/**
 * Checks whether an operating system process with the given `pid` is currently alive.
 *
 * Sends signal `0` via `process.kill(pid, 0)`: returns `true` when the process exists (including `EPERM`
 * when owned by another user) and `false` when the kernel reports `ESRCH` or an invalid PID.
 *
 * @param {number} pid - Operating system process identifier to probe.
 *
 * @returns {boolean} True when the process is alive, or false when no such process exists.
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return error instanceof Error && 'code' in error && error.code === 'EPERM';
  }
}

/**
 * Reads and validates the JSON `FileLockRecord` stored inside an existing lockfile on disk.
 *
 * Returns `undefined` when the lockfile was concurrently removed or has not yet finished flushing
 * its initial JSON payload.
 *
 * @param {string} resolvedLockPath - Absolute path of the lockfile to inspect.
 *
 * @returns {Promise<FileLockRecord | undefined>} Parsed lock record or `undefined` if unreadable or malformed.
 */
export async function readLockRecord(resolvedLockPath: string): Promise<FileLockRecord | undefined> {
  try {
    const rawText = await readFile(resolvedLockPath, 'utf8');
    const parsed: unknown = JSON.parse(rawText);
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    if (!('pid' in parsed) || typeof parsed.pid !== 'number') return undefined;
    if (!('acquiredAtMs' in parsed) || typeof parsed.acquiredAtMs !== 'number') return undefined;
    if (!('ownerToken' in parsed) || typeof parsed.ownerToken !== 'string') return undefined;
    return { pid: parsed.pid, acquiredAtMs: parsed.acquiredAtMs, ownerToken: parsed.ownerToken };
  } catch {
    return undefined;
  }
}

/**
 * Determines whether an existing lockfile is stale due to an expired `mtime` heartbeat or a dead holder PID.
 *
 * Inspects both the filesystem `mtimeMs` age against `staleMs` and the liveness of the recorded `pid`
 * so `SIGKILL`ed holders are detected immediately without waiting for `staleMs` to elapse.
 *
 * @param {string} resolvedLockPath - Absolute path of the contending lockfile.
 * @param {number} staleMs          - Maximum allowed heartbeat age in milliseconds before expiration.
 *
 * @returns {Promise<boolean>} True when the existing lockfile is stale and eligible for atomic reclamation.
 */
export async function isExistingLockStale(resolvedLockPath: string, staleMs: number): Promise<boolean> {
  try {
    const stats = await stat(resolvedLockPath);
    const record = await readLockRecord(resolvedLockPath);
    if (record !== undefined && !isProcessAlive(record.pid)) return true;
    return Date.now() - stats.mtimeMs > staleMs;
  } catch {
    return false;
  }
}

/**
 * Atomically reclaims a stale lockfile under an exclusive `.reclaim` guard lockfile.
 *
 * Acquires `${resolvedLockPath}.reclaim` via `open(..., 'wx')`, re-verifies that `resolvedLockPath` is
 * still stale, unlinks the stale file, and creates the replacement lockfile exclusively via `open(..., 'wx')`
 * so concurrent contenders cannot overwrite one another.
 *
 * @param {string} resolvedLockPath - Absolute path of the stale lockfile to reclaim.
 * @param {string} serializedRecord - JSON-serialized `FileLockRecord` for the new lease holder.
 * @param {number} staleMs          - Maximum allowed heartbeat age in milliseconds before expiration.
 *
 * @returns {Promise<boolean>} True if the stale lockfile was exclusively reclaimed by this caller.
 */
export async function tryReclaimStaleLock(
  resolvedLockPath: string,
  serializedRecord: string,
  staleMs: number,
): Promise<boolean> {
  const reclaimLockPath = `${resolvedLockPath}.reclaim`;
  const reclaimHandle = await open(reclaimLockPath, 'wx').catch(async () => {
    if (await isExistingLockStale(reclaimLockPath, staleMs)) {
      await unlink(reclaimLockPath).catch(() => undefined);
    }
    return undefined;
  });
  if (reclaimHandle === undefined) return false;
  try {
    if (!(await isExistingLockStale(resolvedLockPath, staleMs))) return false;
    await unlink(resolvedLockPath);
    const lockHandle = await open(resolvedLockPath, 'wx');
    let wrotePayload = false;
    try {
      await lockHandle.writeFile(serializedRecord, 'utf8');
      wrotePayload = true;
      return true;
    } finally {
      await lockHandle.close();
      if (!wrotePayload) await unlink(resolvedLockPath).catch(() => undefined);
    }
  } catch {
    return false;
  } finally {
    await reclaimHandle.close().catch(() => undefined);
    await unlink(reclaimLockPath).catch(() => undefined);
  }
}
