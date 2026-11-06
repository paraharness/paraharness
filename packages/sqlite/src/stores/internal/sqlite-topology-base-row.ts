/**
 * Raw SQLite row shape for `harness_topology_base`.
 *
 * Maps canonical base partition state columns for `SqliteTopologyStore`.
 */
export interface SqliteTopologyBaseRow {
  /** Logical partition identifier. */
  readonly partition_id: string;
  /** Monotonic base epoch integer. */
  readonly epoch: number;
  /** Canonical contract text in the base store. */
  readonly contract_text: string;
  /** ISO-8601 timestamp of the last base update. */
  readonly updated_at: string;
  /** Run ID that most recently committed a mutation to this partition, or `null`. */
  readonly last_mutated_by_run_id: string | null;
}
