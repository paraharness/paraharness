export type { RunTerminalReceipt } from './run-terminal-receipt.js';

/**
 * Terminal run receipt entry returned by `LedgerStore.getRunTerminalReceipts()`.
 *
 * Records the completed run identifier, terminal exit state, and optional final scope receipt JSON.
 */
export interface RunTerminalReceiptRecord {
  /** Identifier of the completed or terminated run. */
  readonly runId: string;
  /** Terminal exit state string (such as `'done'`, `'abandoned'`, `'exhausted'`, `'cancelled'`). */
  readonly terminalState: string;
  /** Optional JSON-serialized final scope receipt (`TReceipt`). */
  readonly scopeReceiptJson?: string;
}
