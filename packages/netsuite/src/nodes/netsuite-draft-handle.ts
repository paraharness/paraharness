/**
 * Individual journal line entry staged inside a `NetSuiteDraftHandle`.
 *
 * Tracks the target general-ledger account, debit and credit amounts in USD,
 * accounting period identifier, and whether the target period is closed.
 */
export interface NetSuiteJournalLineEntry {
  /** NetSuite general-ledger account identifier. */
  readonly accountId: string;
  /** Debit amount in USD (`>= 0`). */
  readonly debitUsd: number;
  /** Credit amount in USD (`>= 0`). */
  readonly creditUsd: number;
  /** Accounting period identifier (such as `'2026-03'`). */
  readonly postingPeriod: string;
  /** Optional flag indicating whether `postingPeriod` is closed for posting. */
  readonly periodClosed?: boolean;
}

/**
 * Runtime scope handle representing a staged NetSuite draft journal entry (`netsuite.draftJournalScope`).
 *
 * Holds mutable or copy-on-write staged journal lines and lifecycle status managed by
 * `NetSuiteDraftScopeDriver` (`acquireRoot`, `reattachRoot`, `inspect`, `release`).
 */
export interface NetSuiteDraftHandle {
  /** Unique identifier of the enclosing harness run. */
  readonly runId: string;
  /** Deterministic NetSuite draft journal identifier (`"draft-${runId}"`). */
  readonly journalId: string;
  /** Current lifecycle status of the draft journal scope. */
  status: 'open' | 'rolled-back' | 'committed' | 'released';
  /** Staged journal line entries accumulated during the step or run. */
  readonly entries: NetSuiteJournalLineEntry[];
}
