import type {
  NetSuiteBalanceZeroCheckNode,
  NetSuiteClosedPeriodGuardNode,
  NetSuiteDraftScopeNode,
  NetSuiteJournalToolNode,
  NetSuiteRollbackAbortHookNode,
} from '@metaharness/netsuite';
import type {
  StripeMaxRefundGuardNode,
  StripeMaxRefundMatcherNode,
  StripeReadToolNode,
} from '@metaharness/stripe';

declare module '@metaharness/core' {
  /**
   * Open declaration-merged registry augmenting `@metaharness/core` with financial domain AST nodes (`SPEC.md` §5).
   *
   * Registers Tier-1 `NetSuiteDraftScopeNode` (`capabilityTier: 'scope'`), policy guards, rollback abort hooks,
   * Stripe and NetSuite tools, balance-zero checks, and `StripeMaxRefundMatcherNode` effect matchers.
   */
  interface CustomDomainASTRegistry {
    /** Tier-1 NetSuite draft journal isolation scope AST node (`capabilityTier: 'scope'`). */
    scope: NetSuiteDraftScopeNode;
    /** Financial policy guard AST nodes for closed-period posting and Stripe refund thresholds. */
    guard: NetSuiteClosedPeriodGuardNode | StripeMaxRefundGuardNode;
    /** NetSuite draft journal rollback abort hook AST node. */
    abortHook: NetSuiteRollbackAbortHookNode;
    /** Stripe read/refund and NetSuite journal entry tool AST nodes. */
    tool: StripeReadToolNode | NetSuiteJournalToolNode;
    /** NetSuite draft journal zero-balance verification check AST node. */
    check: NetSuiteBalanceZeroCheckNode;
    /** Stripe refund limit lease-elevation effect matcher AST node. */
    effectMatcher: StripeMaxRefundMatcherNode;
  }
}
