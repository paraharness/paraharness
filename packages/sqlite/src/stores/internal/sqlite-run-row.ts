/**
 * Raw SQLite row shape for `harness_runs` and `harness_terminal_receipts` queries.
 *
 * Maps snake_case database columns to typed properties for `SqliteLedgerStore` run operations.
 */
export interface SqliteRunRow {
  /** Unique flow run identifier. */
  readonly run_id: string;
  /** Enclosing lane identifier. */
  readonly lane_id: string;
  /** Work item deduplication key. */
  readonly item_key: string;
  /** Persisted run lifecycle status string. */
  readonly status: string;
  /** Currently executing step ID, or `null`. */
  readonly current_step_id: string | null;
  /** JSON-serialized flow input payload. */
  readonly input_json: string;
  /** Pending rewind target step ID, or `null`. */
  readonly rewind_pending_to_step_id: string | null;
  /** JSON-serialized map of pinned wire prefixes, or `null`. */
  readonly compiled_prefixes_json: string | null;
  /** Cumulative run cost in USD. */
  readonly cost_usd: number;
  /** Human-approved maximum cost in USD, or `null`. */
  readonly approved_max_cost_usd: number | null;
  /** JSON-serialized map of completed step IDs to output JSON. */
  readonly completed_step_outputs_json: string;
  /** JSON-serialized array of prerequisite item keys. */
  readonly depends_on_json: string;
  /** Terminal state string when recorded, or `null`. */
  readonly terminal_state: string | null;
  /** JSON-serialized final scope receipt, or `null`. */
  readonly scope_receipt_json: string | null;
}
