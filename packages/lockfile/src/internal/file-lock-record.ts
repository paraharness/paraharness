/**
 * JSON payload persisted inside an active cross-process lockfile on disk.
 *
 * Records the holder's OS process identifier, acquisition timestamp, and unique lease token
 * so contending processes can detect crashed holders (`ESRCH`) and verify atomic stale reclamation.
 */
export interface FileLockRecord {
  /** Operating system PID of the process that acquired the lockfile. */
  readonly pid: number;
  /** Epoch timestamp in milliseconds when the lockfile was created or reclaimed. */
  readonly acquiredAtMs: number;
  /** Unique lease token distinguishing concurrent or sequential lock acquisitions. */
  readonly ownerToken: string;
}
