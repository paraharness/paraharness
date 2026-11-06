/**
 * Parameter object for `recordRunTerminalReceiptInSqlite`.
 *
 * Bundles the run ID, item key, terminal exit state, and optional scope receipt JSON.
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
