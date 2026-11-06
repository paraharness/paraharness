/**
 * Relational row shape for `harness_topology_overlays` in PostgreSQL.
 *
 * Captures per-run Copy-on-Write partition overlays, pinned merge-base contract texts,
 * prerequisite-synced baselines, and step-scoped rollback journals.
 */
export interface PgTopologyOverlayRow {
  /** Enclosing flow run identifier. */
  readonly run_id: string;
  /** Target partition identifier. */
  readonly partition_id: string;
  /** Overlay epoch counter (incremented at most once per `(runId, partitionId)`). */
  readonly epoch: number;
  /** Current overlay contract text. */
  readonly contract_text: string;
  /** Merge-base contract text pinned at first acquire or advanced by `syncRunOverlays`. */
  readonly base_contract_text_at_acquire: string;
  /** Original canonical base contract text when first acquired. */
  readonly initial_base_contract_text: string;
  /** Baseline contract text after any `syncRunOverlays` calls (target for `scope: 'run'` reset). */
  readonly baseline_contract_text: string;
  /** Baseline epoch after any `syncRunOverlays` calls. */
  readonly baseline_epoch: number;
  /** Baseline `last_mutated_by_run_id` after any `syncRunOverlays` calls. */
  readonly baseline_last_mutated_by_run_id: string | null;
  /** `1` if `updateContract` was invoked directly by `run_id` since the last reset, else `0`. */
  readonly mutated_in_run: number;
  /** `1` if this overlay holds uncommitted or absorbed prerequisite changes, else `0`. */
  readonly has_uncommitted_changes: number;
  /** Run identifier that last mutated this overlay partition. */
  readonly last_mutated_by_run_id: string | null;
  /** Overlay status (`'ACTIVE' | 'SEALED_UNMERGED'`). */
  readonly status: string;
  /** ISO-8601 timestamp of last overlay update. */
  readonly updated_at: string;
  /** JSON-serialized `string[]` of absorbed prerequisite run IDs. */
  readonly absorbed_run_ids_json: string;
  /** JSON-serialized `PgOverlayStepMutationEntry[]` journal for `scope: 'step'` rollback. */
  readonly step_mutations_json: string;
}
