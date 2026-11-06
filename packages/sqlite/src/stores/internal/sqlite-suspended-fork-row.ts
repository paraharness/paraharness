/**
 * Raw SQLite row shape for `harness_suspended_forks`.
 *
 * Maps snake_case columns for suspended fork persistence, filtering, and recursive epoch resolution.
 */
export interface SqliteSuspendedForkRow {
  /** Monotonic `${forkId}#${suspensionEpoch}` identifier. */
  readonly suspended_fork_id: string;
  /** Logical fork identifier. */
  readonly fork_id: string;
  /** Positive integer suspension epoch. */
  readonly suspension_epoch: number;
  /** Enclosing flow run identifier. */
  readonly run_id: string;
  /** Parent step execution identifier. */
  readonly parent_step_exec_id: string;
  /** Full JSON-serialized `SuspendedForkRecord`. */
  readonly record_json: string;
  /** Resolution status (`'RESUMED' | 'ABORTED' | null`). */
  readonly resolution_status: string | null;
}
