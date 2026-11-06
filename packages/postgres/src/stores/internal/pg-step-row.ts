/**
 * Relational row shape for `harness_steps` in PostgreSQL.
 *
 * Captures step execution attempts, scope checkpoints, serialized continuation stacks,
 * and universal telemetry snapshots.
 */
export interface PgStepRow {
  /** Primary key step execution identifier. */
  readonly step_exec_id: string;
  /** Enclosing flow run identifier. */
  readonly run_id: string;
  /** Logical flow step identifier. */
  readonly step_id: string;
  /** Promoted or active executable identifier or `null`. */
  readonly executable_id: string | null;
  /** Initial message frame ID or `null`. */
  readonly input_msg_id: string | null;
  /** Step lifecycle status. */
  readonly status: string;
  /** JSON-serialized step output or `null`. */
  readonly output_json: string | null;
  /** Base scope checkpoint at step start or `null`. */
  readonly base_scope_checkpoint: string | null;
  /** Head scope checkpoint on suspension or completion, or `null`. */
  readonly head_scope_checkpoint: string | null;
  /** JSON-serialized `ContinuationFrame[]` call stack. */
  readonly continuation_stack_json: string;
  /** JSON-serialized `UniversalStepTelemetry` snapshot or `null`. */
  readonly telemetry_json: string | null;
  /** Monotonic insertion sequence number. */
  readonly seq?: number;
}
