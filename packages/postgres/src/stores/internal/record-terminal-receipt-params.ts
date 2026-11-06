/**
 * Parameter object for `recordRunTerminalReceiptInPg`.
 *
 * Bundles the completed run identifier, deduplication item key, terminal state,
 * and optional serialized scope receipt to satisfy the 3-parameter ceiling.
 */
export interface RecordTerminalReceiptParams {
  /** Completed flow run identifier. */
  readonly runId: string;
  /** Work item deduplication key. */
  readonly itemKey: string;
  /** Terminal exit state string. */
  readonly terminalState: string;
  /** Optional JSON-serialized final scope receipt. */
  readonly scopeReceiptJson?: string;
}
