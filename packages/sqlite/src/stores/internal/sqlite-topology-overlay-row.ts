/**
 * Raw SQLite row shape for `harness_topology_overlays`.
 *
 * Tracks per-run Copy-on-Write partition overlays, pinned 3-way merge baselines, and step mutation history.
 */
export interface SqliteTopologyOverlayRow {
  /** Active or sealed flow run identifier. */
  readonly run_id: string;
  /** Logical partition identifier. */
  readonly partition_id: string;
  /** Current overlay epoch number. */
  readonly epoch: number;
  /** Current overlay contract text. */
  readonly contract_text: string;
  /** Pinned 3-way merge-base contract text (advanced on `syncRunOverlays`). */
  readonly base_contract_text_at_acquire: string;
  /** Initial canonical base contract text when the overlay chain was first acquired. */
  readonly initial_base_contract_text: string;
  /** Run-start or synced-prerequisite baseline contract text for `scope: 'run'` resets. */
  readonly baseline_contract_text: string;
  /** Run-start or synced-prerequisite baseline epoch for `scope: 'run'` resets. */
  readonly baseline_epoch: number;
  /** Run-start or synced-prerequisite `last_mutated_by_run_id` for `scope: 'run'` resets. */
  readonly baseline_last_mutated_by_run_id: string | null;
  /** `1` if `updateContract` was already called in `run_id` since the last reset, `0` otherwise. */
  readonly mutated_in_run: number;
  /** `1` if the overlay carries uncommitted or absorbed prerequisite changes, `0` if purely pinned on read. */
  readonly has_uncommitted_changes: number;
  /** Run ID that most recently mutated this partition in the overlay lineage, or `null`. */
  readonly last_mutated_by_run_id: string | null;
  /** Overlay lifecycle status (`'ACTIVE' | 'SEALED_UNMERGED'`). */
  readonly status: string;
  /** ISO-8601 timestamp of the latest overlay update. */
  readonly updated_at: string;
  /** JSON-serialized `string[]` of prerequisite run IDs absorbed via `syncRunOverlays`. */
  readonly absorbed_run_ids_json: string;
  /** JSON-serialized `SqliteOverlayStepMutationEntry[]` for step-scoped rollback. */
  readonly step_mutations_json: string;
}
