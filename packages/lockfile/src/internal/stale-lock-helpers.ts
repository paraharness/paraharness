import { randomUUID } from 'node:crypto';
import { readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
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
 * Atomically reclaims a stale lockfile by writing a temporary claim file and renaming it over `resolvedLockPath`.
 *
 * Re-reads `resolvedLockPath` after the atomic rename to verify that this caller's `ownerToken` won any
 * concurrent reclamation race.
 *
 * @param {string} resolvedLockPath - Absolute path of the stale lockfile to reclaim.
 * @param {string} serializedRecord - JSON-serialized `FileLockRecord` for the new lease holder.
 * @param {string} ownerToken       - Unique token identifying the reclaiming caller.
 *
 * @returns {Promise<boolean>} True if the stale lockfile was reclaimed and verified as owned by `ownerToken`.
 */
export async function tryReclaimStaleLock(
  resolvedLockPath: string,
  serializedRecord: string,
  ownerToken: string,
): Promise<boolean> {
  const claimPath = `${resolvedLockPath}.claim.${process.pid}.${randomUUID()}`;
  try {
    await writeFile(claimPath, serializedRecord, 'utf8');
    await rename(claimPath, resolvedLockPath);
    const currentRecord = await readLockRecord(resolvedLockPath);
    return currentRecord?.ownerToken === ownerToken;
  } catch {
    await unlink(claimPath).catch(() => undefined);
    return false;
  }
}
