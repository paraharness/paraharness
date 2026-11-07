import type Big from 'big.js';

/**
 * Exact `big.js` decimal totals computed across a list of `NetSuiteJournalLineEntry` records.
 *
 * Used by both `NetSuiteDraftScopeDriver.inspect` and `evaluateNetSuiteBalanceZeroCheck`.
 */
export interface NetSuiteJournalTotals {
  /** Sum of all staged debit line amounts as an exact `Big` decimal. */
  readonly totalDebit: Big;
  /** Sum of all staged credit line amounts as an exact `Big` decimal. */
  readonly totalCredit: Big;
  /** Exact net balance (`totalDebit.minus(totalCredit)`). */
  readonly netBalance: Big;
}
