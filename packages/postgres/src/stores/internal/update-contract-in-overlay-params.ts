/**
 * Parameter object for `updateContractInPgOverlay`.
 *
 * Bundles the run ID, partition ID, updated contract text, and optional step execution ID.
 */
export interface UpdateContractInOverlayParams {
  /** Active flow run identifier. */
  readonly runId: string;
  /** Target partition identifier. */
  readonly partitionId: string;
  /** Updated contract Markdown/text. */
  readonly newContractText: string;
  /** Optional step execution identifier for step-scoped rollback. */
  readonly stepExecId?: string;
}
