/**
 * Step-level undo entry recorded inside `harness_topology_overlays.step_mutations_json` in PostgreSQL.
 *
 * Captures the prior contract text, epoch, and mutation flags before a step's `updateContract` call
 * so `resetRunOverlay(runId, { scope: 'step', stepExecId })` can roll back only that step's changes.
 */
export interface PgOverlayStepMutationEntry {
  /** Step execution identifier that performed the contract update, or `null`. */
  readonly stepExecId: string | null;
  /** Contract text prior to this mutation. */
  readonly prevContractText: string;
  /** Overlay epoch prior to this mutation. */
  readonly prevEpoch: number;
  /** `mutated_in_run` flag (`0` or `1`) prior to this mutation. */
  readonly prevMutatedInRun: number;
  /** `has_uncommitted_changes` flag (`0` or `1`) prior to this mutation. */
  readonly prevHasUncommittedChanges: number;
  /** `last_mutated_by_run_id` prior to this mutation. */
  readonly prevLastMutatedByRunId: string | null;
}
