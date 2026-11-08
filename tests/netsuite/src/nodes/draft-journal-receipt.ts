/**
 * Validated inspection receipt returned by `NetSuiteDraftScopeDriver.inspect(handle)`.
 *
 * Summarizes the draft journal's total debits, total credits, net balance, and line count
 * for `.inputFrom()` projections and deterministic balance verification.
 */
export interface DraftJournalReceipt extends Record<string, unknown> {
  /** NetSuite draft journal identifier. */
  readonly journalId: string;
  /** Enclosing harness run identifier. */
  readonly runId: string;
  /** Current lifecycle status of the draft journal. */
  readonly status: 'open' | 'rolled-back' | 'committed' | 'released';
  /** Sum of all staged debit amounts in USD. */
  readonly totalDebitUsd: number;
  /** Sum of all staged credit amounts in USD. */
  readonly totalCreditUsd: number;
  /** Net balance (`totalDebitUsd - totalCreditUsd`) in USD (`0` when balanced). */
  readonly netBalanceUsd: number;
  /** Number of staged journal lines currently in the draft journal. */
  readonly lineCount: number;
}
