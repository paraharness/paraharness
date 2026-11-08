import Big from 'big.js';
import type { NetSuiteJournalLineEntry } from '../../nodes/netsuite-draft-handle.js';
import type { NetSuiteJournalTotals } from './netsuite-journal-totals.js';

/**
 * Sums total debits, total credits, and net balance across `entries` using exact `big.js` arithmetic.
 *
 * Prevents IEEE-754 floating-point drift (such as `0.1 + 0.2 !== 0.3`) on financial ledger entries.
 *
 * @param {readonly NetSuiteJournalLineEntry[]} entries - Staged NetSuite draft journal lines.
 *
 * @returns {NetSuiteJournalTotals} Exact `Big` debit, credit, and net balance totals.
 */
export function computeNetSuiteJournalTotals(
  entries: readonly NetSuiteJournalLineEntry[],
): NetSuiteJournalTotals {
  let totalDebit = new Big(0);
  let totalCredit = new Big(0);
  for (const entry of entries) {
    totalDebit = totalDebit.plus(new Big(entry.debitUsd));
    totalCredit = totalCredit.plus(new Big(entry.creditUsd));
  }
  const netBalance = totalDebit.minus(totalCredit);
  return Object.freeze<NetSuiteJournalTotals>({
    totalDebit,
    totalCredit,
    netBalance,
  });
}
