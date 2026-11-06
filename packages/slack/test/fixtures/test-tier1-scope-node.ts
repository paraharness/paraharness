import type { BaseIsolationScopeASTNode } from '@harness-dsl/core';

/**
 * Passive Tier-1 isolation scope AST node fixture used in `@harness-dsl/slack` tests.
 *
 * Verifies that `slack.bot` human channels compose cleanly into a Tier-1 `'scope'` workflow.
 */
export interface SlackTestTier1ScopeNode
  extends BaseIsolationScopeASTNode<
    'slack-test:tier1-scope',
    Record<string, unknown>,
    Record<string, unknown>,
    Record<string, unknown>,
    'scope'
  > {
  /** Discriminant for the test Tier-1 scope fixture. */
  readonly type: 'slack-test:tier1-scope';
}

declare module '@harness-dsl/core' {
  /**
   * Augments `CustomDomainASTRegistry` with the test-only `'scope:slack-test'` Tier-1 scope fixture.
   *
   * Enables `H.flow(...).scope(...)` composition tests inside `@harness-dsl/slack` test suites.
   */
  interface CustomDomainASTRegistry {
    /** Test-only Tier-1 scope fixture entry for `@harness-dsl/slack`. */
    readonly 'scope:slack-test': SlackTestTier1ScopeNode;
  }
}
