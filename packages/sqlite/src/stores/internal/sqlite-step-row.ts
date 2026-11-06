/**
 * Raw SQLite row shape for `harness_step_executions`.
 *
 * Maps snake_case database columns to typed properties for `SqliteLedgerStore` step operations.
 */
export interface SqliteStepRow {
  /** Unique step execution identifier. */
  readonly step_exec_id: string;
  /** Enclosing flow run identifier. */
  readonly run_id: string;
  /** Logical flow step identifier. */
  readonly step_id: string;
  /** Optional promoted executable identifier, or `null`. */
  readonly executable_id: string | null;
  /** Optional input message frame ID, or `null`. */
  readonly input_msg_id: string | null;
  /** Step execution lifecycle status. */
  readonly status: string;
  /** JSON-serialized step output when completed, or `null`. */
  readonly output_json: string | null;
  /** Serialized base scope checkpoint, or `null`. */
  readonly base_scope_checkpoint: string | null;
  /** Serialized head scope checkpoint on suspension, or `null`. */
  readonly head_scope_checkpoint: string | null;
  /** JSON-serialized `ContinuationFrame[]` call stack. */
  readonly continuation_stack_json: string;
  /** JSON-serialized `UniversalStepTelemetry` payload, or `null`. */
  readonly telemetry_json: string | null;
  /** Monotonic sequence integer within the ledger. */
  readonly seq_id: number;
}
