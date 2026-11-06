/**
 * Step-scoped contract mutation history entry stored inside `harness_topology_overlays.step_mutations_json`.
 *
 * Captures the pre-mutation overlay state so `resetRunOverlay(runId, { scope: 'step', stepExecId })`
 * can revert uncommitted edits from a single failed/aborted step while preserving prior steps.
 */
export interface SqliteOverlayStepMutationEntry {
  /** Step execution identifier that performed the mutation, or `null`. */
  readonly stepExecId: string | null;
  /** Contract text prior to this mutation. */
  readonly prevContractText: string;
  /** Overlay epoch prior to this mutation. */
  readonly prevEpoch: number;
  /** `mutated_in_run` flag (`0` or `1`) prior to this mutation. */
  readonly prevMutatedInRun: number;
  /** `has_uncommitted_changes` flag (`0` or `1`) prior to this mutation. */
  readonly prevHasUncommittedChanges: number;
  /** `last_mutated_by_run_id` value prior to this mutation. */
  readonly prevLastMutatedByRunId: string | null;
}
