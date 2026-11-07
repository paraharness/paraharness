/**
 * Normalized file lock configuration with all optional timing fields populated from defaults.
 *
 * Passed to internal disk lock acquisition and heartbeat routines so downstream helpers never
 * repeat default coalescing checks.
 */
export interface ResolvedFileLockOptions {
  /** Maximum milliseconds to wait for lock acquisition before throwing a timeout error. */
  readonly timeoutMs: number;
  /** Maximum milliseconds since last `mtime` heartbeat before a lockfile is considered stale. */
  readonly staleMs: number;
  /** Interval in milliseconds between `utimes` heartbeat updates while the lock is held. */
  readonly heartbeatIntervalMs: number;
  /** Delay in milliseconds between cross-process `EEXIST` polling retries. */
  readonly retryDelayMs: number;
  /** Optional abort signal cancelling queued lock acquisition before entering the critical section. */
  readonly signal: AbortSignal | undefined;
}
