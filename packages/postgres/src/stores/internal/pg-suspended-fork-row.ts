/**
 * Relational row shape for `harness_suspended_forks` in PostgreSQL.
 *
 * Tracks suspended child fork snapshots keyed by monotonic `suspended_fork_id` (`${forkId}#${suspensionEpoch}`).
 */
export interface PgSuspendedForkRow {
  /** Monotonic suspension identifier `${forkId}#${suspensionEpoch}`. */
  readonly suspended_fork_id: string;
  /** Logical fork identifier. */
  readonly fork_id: string;
  /** Positive integer suspension epoch counter. */
  readonly suspension_epoch: number;
  /** Enclosing flow run identifier. */
  readonly run_id: string;
  /** Parent step execution identifier. */
  readonly parent_step_exec_id: string;
  /** Resolution status (`'SUSPENDED' | 'RESUMED' | 'ABORTED'`). */
  readonly status: string;
  /** Full JSON-serialized `SuspendedForkRecord`. */
  readonly record_json: string;
}
