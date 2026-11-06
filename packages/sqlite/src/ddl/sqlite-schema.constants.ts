/**
 * Regular expression enforcing safe SQL table and identifier syntax (`^[A-Za-z_][A-Za-z0-9_]*$`).
 *
 * Rejects quotes, whitespace, semicolons, schema separators, and SQL injection payloads.
 */
export const SQL_IDENTIFIER_REGEX: RegExp = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * SQLite connection PRAGMA statements executed immediately when opening a WAL-mode database.
 *
 * Enables Write-Ahead Logging (`WAL`), normal fsync synchronization, foreign-key enforcement,
 * and a 5-second busy timeout for concurrent readers and writers.
 */
export const SQLITE_PRAGMA_STATEMENTS: readonly string[] = Object.freeze([
  'PRAGMA journal_mode = WAL;',
  'PRAGMA synchronous = NORMAL;',
  'PRAGMA foreign_keys = ON;',
  'PRAGMA busy_timeout = 5000;',
]);

/**
 * Idempotent SQLite DDL statements initializing tables for `SqliteLedgerStore`, `SqliteTopologyStore`,
 * and `SqliteLessonStore`.
 *
 * Executed inside an initialization transaction whenever a SQLite store connection is opened.
 */
export const SQLITE_DDL_STATEMENTS: readonly string[] = Object.freeze([
  `CREATE TABLE IF NOT EXISTS harness_runs (
    run_id TEXT PRIMARY KEY,
    lane_id TEXT NOT NULL,
    item_key TEXT NOT NULL,
    status TEXT NOT NULL,
    current_step_id TEXT,
    input_json TEXT NOT NULL,
    rewind_pending_to_step_id TEXT,
    compiled_prefixes_json TEXT,
    cost_usd REAL NOT NULL DEFAULT 0,
    approved_max_cost_usd REAL,
    completed_step_outputs_json TEXT NOT NULL DEFAULT '{}',
    depends_on_json TEXT NOT NULL DEFAULT '[]',
    priority TEXT NOT NULL DEFAULT 'normal',
    terminal_state TEXT,
    scope_receipt_json TEXT,
    compacted INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
  );`,
  `CREATE TABLE IF NOT EXISTS harness_lane_items (
    lane_id TEXT NOT NULL,
    item_key TEXT NOT NULL,
    input_json TEXT NOT NULL,
    depends_on_json TEXT NOT NULL DEFAULT '[]',
    priority TEXT NOT NULL DEFAULT 'normal',
    latest_spawned_tip_key TEXT,
    PRIMARY KEY (lane_id, item_key)
  );`,
  `CREATE TABLE IF NOT EXISTS harness_step_executions (
    step_exec_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    step_id TEXT NOT NULL,
    executable_id TEXT,
    input_msg_id TEXT,
    status TEXT NOT NULL,
    output_json TEXT,
    base_scope_checkpoint TEXT,
    head_scope_checkpoint TEXT,
    continuation_stack_json TEXT NOT NULL,
    telemetry_json TEXT,
    seq_id INTEGER NOT NULL
  );`,
  `CREATE TABLE IF NOT EXISTS harness_wire_frames (
    message_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    parent_message_id TEXT,
    vendor_id TEXT NOT NULL,
    raw_wire_frame BLOB NOT NULL,
    canonical_json TEXT NOT NULL,
    prefix_digest TEXT NOT NULL,
    compacted_tombstones_json TEXT,
    is_compacted INTEGER NOT NULL DEFAULT 0
  );`,
  `CREATE TABLE IF NOT EXISTS harness_suspended_forks (
    suspended_fork_id TEXT PRIMARY KEY,
    fork_id TEXT NOT NULL,
    suspension_epoch INTEGER NOT NULL,
    run_id TEXT NOT NULL,
    parent_step_exec_id TEXT NOT NULL,
    record_json TEXT NOT NULL,
    resolution_status TEXT
  );`,
  `CREATE TABLE IF NOT EXISTS harness_terminal_receipts (
    item_key TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    terminal_state TEXT NOT NULL,
    scope_receipt_json TEXT,
    recorded_at TEXT NOT NULL
  );`,
  `CREATE TABLE IF NOT EXISTS harness_topology_base (
    partition_id TEXT PRIMARY KEY,
    epoch INTEGER NOT NULL,
    contract_text TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_mutated_by_run_id TEXT
  );`,
  `CREATE TABLE IF NOT EXISTS harness_topology_overlays (
    run_id TEXT NOT NULL,
    partition_id TEXT NOT NULL,
    epoch INTEGER NOT NULL,
    contract_text TEXT NOT NULL,
    base_contract_text_at_acquire TEXT NOT NULL,
    initial_base_contract_text TEXT NOT NULL,
    baseline_contract_text TEXT NOT NULL,
    baseline_epoch INTEGER NOT NULL,
    baseline_last_mutated_by_run_id TEXT,
    mutated_in_run INTEGER NOT NULL DEFAULT 0,
    has_uncommitted_changes INTEGER NOT NULL DEFAULT 0,
    last_mutated_by_run_id TEXT,
    status TEXT NOT NULL DEFAULT 'ACTIVE',
    updated_at TEXT NOT NULL,
    absorbed_run_ids_json TEXT NOT NULL DEFAULT '[]',
    step_mutations_json TEXT NOT NULL DEFAULT '[]',
    PRIMARY KEY (run_id, partition_id)
  );`,
  `CREATE TABLE IF NOT EXISTS harness_lessons (
    id TEXT PRIMARY KEY,
    partition TEXT,
    directive TEXT NOT NULL,
    epoch_at_creation INTEGER NOT NULL,
    created_by_run_id TEXT,
    recent_outcomes_json TEXT NOT NULL DEFAULT '[]',
    total_clean_passes INTEGER NOT NULL DEFAULT 0,
    total_violated INTEGER NOT NULL DEFAULT 0,
    signal_last_emitted_at_json TEXT,
    retired INTEGER NOT NULL DEFAULT 0
  );`,
]);
