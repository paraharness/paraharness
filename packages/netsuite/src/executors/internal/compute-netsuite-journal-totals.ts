import Big from 'big.js';
import type {
  NetSuiteDraftHandle,
  NetSuiteJournalLineEntry,
} from '../../nodes/netsuite-draft-handle.js';
import type { NetSuiteJournalTotals } from './netsuite-journal-totals.js';

/**
 * Type predicate verifying that an opaque runtime scope handle conforms to `NetSuiteDraftHandle`.
 *
 * Checks that `candidate` is a non-null object carrying string `runId` and `journalId` fields
 * and an `entries` array.
 *
 * @param {unknown} candidate - Opaque scope handle value to inspect.
 *
 * @returns {boolean} `true` when `candidate` is a valid `NetSuiteDraftHandle`.
 */
export function isNetSuiteDraftHandle(candidate: unknown): candidate is NetSuiteDraftHandle {
  if (typeof candidate !== 'object' || candidate === null) {
    return false;
  }
  const record = candidate as Record<string, unknown>;
  return (
    typeof record['runId'] === 'string' &&
    typeof record['journalId'] === 'string' &&
    Array.isArray(record['entries'])
  );
}

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
