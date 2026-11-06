/**
 * Relational row shape for `harness_topology_base` in PostgreSQL.
 *
 * Stores canonical base partition contracts, monotonic epochs, and attribution metadata.
 */
export interface PgTopologyBaseRow {
  /** Primary key partition identifier. */
  readonly partition_id: string;
  /** Monotonic canonical epoch counter. */
  readonly epoch: number;
  /** Canonical contract Markdown/text. */
  readonly contract_text: string;
  /** ISO-8601 timestamp of last update. */
  readonly updated_at: string;
  /** Run identifier that last mutated this partition or `null`. */
  readonly last_mutated_by_run_id: string | null;
}
