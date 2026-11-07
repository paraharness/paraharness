/**
 * Parameter object for `createHeartbeatLease`.
 *
 * Bundles the acquired lockfile path, unique lease token, heartbeat interval, and queue-slot release
 * callback so `createHeartbeatLease` adheres to the `<= 3` parameter limit.
 */
export interface CreateHeartbeatLeaseParams {
  /** Canonical absolute path of the acquired lockfile on disk. */
  readonly resolvedLockPath: string;
  /** Unique token written to the lockfile for this lease holder. */
  readonly ownerToken: string;
  /** Interval in milliseconds between `utimes` heartbeat updates. */
  readonly heartbeatIntervalMs: number;
  /** Callback invoked inside `finally` when the lease finishes releasing. */
  readonly onReleased: () => void;
}
