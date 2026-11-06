/**
 * Parameter object for `updateContractInOverlay`.
 *
 * Bundles the run ID, partition ID, new contract text, and optional step execution ID.
 */
export interface UpdateContractInOverlayParams {
  /** Active flow run identifier. */
  readonly runId: string;
  /** Target partition identifier. */
  readonly partitionId: string;
  /** Updated contract text to write to the run's CoW overlay. */
  readonly newContractText: string;
  /** Optional step execution identifier for step-scoped rollback. */
  readonly stepExecId?: string;
}
