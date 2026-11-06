/**
 * Strict regular expression validating SQL table and column identifiers (`^[A-Za-z_][A-Za-z0-9_]*$`).
 */
export const POSTGRES_IDENTIFIER_REGEX = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Ordered PostgreSQL DDL statements initializing the ledger, topology CoW overlay, and lesson store tables.
 */
export const POSTGRES_DDL_STATEMENTS: readonly string[] = Object.freeze([
  `CREATE TABLE IF NOT EXISTS harness_runs (
    run_id TEXT PRIMARY KEY,
    lane_id TEXT NOT NULL,
    item_key TEXT NOT NULL,
    status TEXT NOT NULL,
    current_step_id TEXT,
    input_json TEXT NOT NULL,
    rewind_pending_to_step_id TEXT,
    compiled_prefixes_json TEXT,
    cost_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
    approved_max_cost_usd DOUBLE PRECISION,
    terminal_state TEXT,
    scope_receipt_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );`,
  `CREATE INDEX IF NOT EXISTS idx_harness_runs_item_key ON harness_runs(item_key);`,
  `CREATE INDEX IF NOT EXISTS idx_harness_runs_status ON harness_runs(status);`,
  `CREATE TABLE IF NOT EXISTS harness_steps (
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
    seq BIGINT GENERATED ALWAYS AS IDENTITY
  );`,
  `CREATE INDEX IF NOT EXISTS idx_harness_steps_run_id ON harness_steps(run_id, seq);`,
  `CREATE TABLE IF NOT EXISTS harness_lane_items (
    lane_id TEXT NOT NULL,
    item_key TEXT NOT NULL,
    input_json TEXT NOT NULL,
    priority TEXT NOT NULL,
    depends_on_json TEXT NOT NULL,
    latest_spawned_tip_key TEXT,
    PRIMARY KEY (lane_id, item_key)
  );`,
  `CREATE TABLE IF NOT EXISTS harness_wire_frames (
    message_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    parent_message_id TEXT,
    vendor_id TEXT NOT NULL,
    raw_wire_frame BYTEA NOT NULL,
    canonical_json TEXT NOT NULL,
    prefix_digest TEXT NOT NULL,
    compacted_tombstones_json TEXT,
    compacted INTEGER NOT NULL DEFAULT 0,
    seq BIGINT GENERATED ALWAYS AS IDENTITY
  );`,
  `CREATE INDEX IF NOT EXISTS idx_harness_wire_frames_run_id ON harness_wire_frames(run_id);`,
  `CREATE TABLE IF NOT EXISTS harness_suspended_forks (
    suspended_fork_id TEXT PRIMARY KEY,
    fork_id TEXT NOT NULL,
    suspension_epoch INTEGER NOT NULL,
    run_id TEXT NOT NULL,
    parent_step_exec_id TEXT NOT NULL,
    status TEXT NOT NULL,
    record_json TEXT NOT NULL
  );`,
  `CREATE INDEX IF NOT EXISTS idx_harness_suspended_forks_run_id ON harness_suspended_forks(run_id, fork_id, suspension_epoch);`,
  `CREATE TABLE IF NOT EXISTS harness_terminal_receipts (
    item_key TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    terminal_state TEXT NOT NULL,
    scope_receipt_json TEXT,
    updated_at TEXT NOT NULL
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
