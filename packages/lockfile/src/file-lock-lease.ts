/**
 * Active lease returned by `acquireFileLock` representing exclusive ownership of a lockfile path.
 *
 * Callers must invoke `release()` inside a `try / finally` block (or prefer `withFileLock`) to stop
 * the background `utimes` heartbeat, remove the lockfile from disk, and advance the in-process `PQueue`.
 */
export interface FileLockLease {
  /** Canonical absolute filesystem path of the acquired lockfile. */
  readonly lockPath: string;
  /** Unique token identifying this specific lease acquisition instance. */
  readonly ownerToken: string;

  /**
   * Cancels the periodic `utimes` heartbeat, awaits any in-flight heartbeat write, and unlinks the lockfile.
   *
   * Safe to invoke multiple times; subsequent calls after the first release resolve as a no-op without
   * disturbing later lock holders.
   *
   * @returns {Promise<void>} Resolves once the heartbeat is stopped, the lockfile is removed, and the queue slot is freed.
   */
  release(): Promise<void>;
}
