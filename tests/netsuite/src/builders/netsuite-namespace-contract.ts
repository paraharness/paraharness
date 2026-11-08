import type { NetSuiteBalanceZeroCheckNode } from '../nodes/netsuite-balance-zero-check-node.js';
import type { NetSuiteClosedPeriodGuardNode } from '../nodes/netsuite-closed-period-guard-node.js';
import type { NetSuiteDraftScopeNode } from '../nodes/netsuite-draft-scope-node.js';
import type { NetSuiteJournalToolNode } from '../nodes/netsuite-journal-tool-node.js';
import type { NetSuiteRollbackAbortHookNode } from '../nodes/netsuite-rollback-abort-hook-node.js';

/**
 * Declarative builder namespace contract for `@paraharness/netsuite` (`netsuite.*`).
 *
 * Provides pure AST factory methods for Tier-1 NetSuite draft journal isolation scopes,
 * closed-period policy guards, journal tools, zero-balance checks, and rollback abort hooks.
 */
export interface NetSuiteNamespace {
  /**
   * Compiles a passive Tier-1 `NetSuiteDraftScopeNode` (`capabilityTier: 'scope'`).
   *
   * Enables non-coding financial workflows to execute over `IsolationScope<NetSuiteDraftHandle, DraftJournalReceipt>`
   * without faking git worktree checkpointing or branching semantics.
   *
   * @param {string} [id='netsuite:draft-journal-scope'] - Optional isolation scope identifier.
   *
   * @returns {NetSuiteDraftScopeNode} Frozen passive NetSuite draft journal scope AST node.
   */
  draftJournalScope(id?: string): NetSuiteDraftScopeNode;

  /**
   * Compiles a passive `NetSuiteClosedPeriodGuardNode` policy guard.
   *
   * Unconditionally denies pre-flight `netsuite:journal-effect` tool calls whose target
   * accounting period is closed (`periodClosed: true`).
   *
   * @param {string} [id='netsuite:forbid-closed-period-posting'] - Optional policy guard identifier.
   *
   * @returns {NetSuiteClosedPeriodGuardNode} Frozen passive NetSuite closed-period policy guard AST node.
   */
  forbidClosedPeriodPosting(id?: string): NetSuiteClosedPeriodGuardNode;

  /**
   * Creates the passive `NetSuiteJournalToolNode` bundle for staging and committing draft journal lines.
   *
   * Returns frozen tool AST nodes configured with `effectTracking: 'declared'` for pre-flight policy inspection.
   *
   * @returns {readonly NetSuiteJournalToolNode[]} Frozen tuple of NetSuite journal tool AST nodes.
   */
  journalTools(): readonly NetSuiteJournalToolNode[];

  /**
   * Compiles a passive `NetSuiteBalanceZeroCheckNode` deterministic check.
   *
   * Verifies at `.beforeStop()` gates that the active `NetSuiteDraftHandle` has equal total debits and credits.
   *
   * @param {string} [id='netsuite:balance-zero-check'] - Optional check node identifier.
   *
   * @returns {NetSuiteBalanceZeroCheckNode} Frozen passive NetSuite zero-balance check AST node.
   */
  balanceZeroCheck(id?: string): NetSuiteBalanceZeroCheckNode;

  /**
   * Compiles a passive `NetSuiteRollbackAbortHookNode` abort hook.
   *
   * Rolls back uncommitted staged journal lines in the active `NetSuiteDraftHandle` when a step aborts or replaces.
   *
   * @param {string} [id='netsuite:rollback-draft-journal'] - Optional abort hook node identifier.
   *
   * @returns {NetSuiteRollbackAbortHookNode} Frozen passive NetSuite draft journal rollback abort hook AST node.
   */
  rollbackDraftJournal(id?: string): NetSuiteRollbackAbortHookNode;
}
