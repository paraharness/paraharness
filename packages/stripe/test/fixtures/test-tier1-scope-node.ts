import type { BaseIsolationScopeASTNode } from '@harness-dsl/core';

/**
 * Passive Tier-1 isolation scope AST node fixture used in `@harness-dsl/stripe` tests.
 *
 * Verifies that `stripe.readTools()` and `stripe.maxRefundGuardUsd()` compose cleanly into a Tier-1 `'scope'` workflow.
 */
export interface StripeTestTier1ScopeNode
  extends BaseIsolationScopeASTNode<
    'stripe-test:tier1-scope',
    Record<string, unknown>,
    Record<string, unknown>,
    Record<string, unknown>,
    'scope'
  > {
  /** Discriminant for the test Tier-1 scope fixture. */
  readonly type: 'stripe-test:tier1-scope';
}

declare module '@harness-dsl/core' {
  /**
   * Augments `CustomDomainASTRegistry` with the test-only `'scope:stripe-test'` Tier-1 scope fixture.
   *
   * Enables `H.flow(...).scope(...)` composition tests inside `@harness-dsl/stripe` test suites.
   */
  interface CustomDomainASTRegistry {
    /** Test-only Tier-1 scope fixture entry for `@harness-dsl/stripe`. */
    readonly 'scope:stripe-test': StripeTestTier1ScopeNode;
  }
}
