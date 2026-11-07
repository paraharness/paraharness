/**
 * Configuration options controlling cross-process file lock acquisition, heartbeat cadence, and stale lock recovery.
 *
 * All timing parameters default to conservative production values when omitted, allowing fast deterministic
 * overrides in unit tests without wall-clock delays.
 */
export interface FileLockOptions {
  /** Maximum milliseconds to wait for lock acquisition before throwing a timeout error. */
  readonly timeoutMs?: number;
  /** Maximum milliseconds since last `mtime` heartbeat before an active PID's lockfile is considered stale. */
  readonly staleMs?: number;
  /** Interval in milliseconds at which the holder updates the lockfile `mtime` while holding the lease. */
  readonly heartbeatIntervalMs?: number;
  /** Polling delay in milliseconds between cross-process `EEXIST` retry attempts. */
  readonly retryDelayMs?: number;
}
