import { createNetSuiteBalanceZeroCheckBuilder } from './create-netsuite-balance-zero-check-builder.js';
import { createNetSuiteClosedPeriodGuardBuilder } from './create-netsuite-closed-period-guard-builder.js';
import { createNetSuiteDraftJournalScopeBuilder } from './create-netsuite-draft-journal-scope-builder.js';
import { createNetSuiteJournalTools } from './create-netsuite-journal-tools.js';
import { createNetSuiteRollbackAbortHookBuilder } from './create-netsuite-rollback-abort-hook-builder.js';
import type { NetSuiteNamespace } from './netsuite-namespace-contract.js';

/**
 * Frozen `@paraharness/netsuite` builder namespace (`netsuite.*`).
 *
 * Exposes `netsuite.draftJournalScope()`, `netsuite.forbidClosedPeriodPosting()`,
 * `netsuite.journalTools()`, `netsuite.balanceZeroCheck()`, and `netsuite.rollbackDraftJournal()`.
 */
export const netsuite: NetSuiteNamespace = Object.freeze<NetSuiteNamespace>({
  draftJournalScope: createNetSuiteDraftJournalScopeBuilder,
  forbidClosedPeriodPosting: createNetSuiteClosedPeriodGuardBuilder,
  journalTools: createNetSuiteJournalTools,
  balanceZeroCheck: createNetSuiteBalanceZeroCheckBuilder,
  rollbackDraftJournal: createNetSuiteRollbackAbortHookBuilder,
});
