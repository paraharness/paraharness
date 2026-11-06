/**
 * Relational row shape for `harness_runs` in PostgreSQL.
 *
 * Represents the persisted state of a single flow run including pinned wire prefixes,
 * cumulative cost, rewind state, and optional terminal receipt.
 */
export interface PgRunRow {
  /** Primary key run identifier. */
  readonly run_id: string;
  /** Enclosing lane identifier. */
  readonly lane_id: string;
  /** Deduplication work item key. */
  readonly item_key: string;
  /** Lifecycle status string. */
  readonly status: string;
  /** Active step ID or `null`. */
  readonly current_step_id: string | null;
  /** JSON-serialized flow input payload. */
  readonly input_json: string;
  /** Pending `.rewindTo()` step ID or `null`. */
  readonly rewind_pending_to_step_id: string | null;
  /** JSON-serialized map of pinned `CompiledWirePrefix` records or `null`. */
  readonly compiled_prefixes_json: string | null;
  /** Cumulative USD cost. */
  readonly cost_usd: number;
  /** Approved maximum USD budget ceiling or `null`. */
  readonly approved_max_cost_usd: number | null;
  /** Terminal exit state or `null`. */
  readonly terminal_state: string | null;
  /** Final scope receipt JSON or `null`. */
  readonly scope_receipt_json: string | null;
  /** ISO-8601 creation timestamp. */
  readonly created_at: string;
  /** ISO-8601 last update timestamp. */
  readonly updated_at: string;
}
