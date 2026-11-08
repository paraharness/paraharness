import type { NetSuiteBalanceZeroCheckNode } from './netsuite-balance-zero-check-node.js';
import type { NetSuiteClosedPeriodGuardNode } from './netsuite-closed-period-guard-node.js';
import type { NetSuiteDraftScopeNode } from './netsuite-draft-scope-node.js';
import type { NetSuiteJournalToolNode } from './netsuite-journal-tool-node.js';
import type { NetSuiteRollbackAbortHookNode } from './netsuite-rollback-abort-hook-node.js';

declare module '@metaharness/core' {
  /**
   * Augments `CustomDomainASTRegistry` with namespaced `@metaharness/netsuite` domain AST nodes.
   *
   * Uses namespaced keys (`'scope:netsuite'`, `'guard:netsuite'`, `'abortHook:netsuite'`,
   * `'tool:netsuite'`, `'check:netsuite'`) so multiple domain adapters coexist without `TS2717` collisions.
   */
  interface CustomDomainASTRegistry {
    /** Namespaced NetSuite Tier-1 draft journal isolation scope AST node entry. */
    readonly 'scope:netsuite': NetSuiteDraftScopeNode;
    /** Namespaced NetSuite closed-period policy guard AST node entry. */
    readonly 'guard:netsuite': NetSuiteClosedPeriodGuardNode;
    /** Namespaced NetSuite draft journal rollback abort hook AST node entry. */
    readonly 'abortHook:netsuite': NetSuiteRollbackAbortHookNode;
    /** Namespaced NetSuite draft journal tool AST node entry. */
    readonly 'tool:netsuite': NetSuiteJournalToolNode;
    /** Namespaced NetSuite zero-balance deterministic check AST node entry. */
    readonly 'check:netsuite': NetSuiteBalanceZeroCheckNode;
  }
}
