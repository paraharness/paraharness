import type { BaseIsolationScopeASTNode } from '@harness-dsl/core';

/**
 * Passive Tier-1 isolation scope AST node fixture used to test `github.createOrUpdatePr` inside `H.flow`.
 *
 * Verifies that `@harness-dsl/github` domain step nodes compose cleanly into a Tier-1 `'scope'` workflow.
 */
export interface GithubTestTier1ScopeNode
  extends BaseIsolationScopeASTNode<
    'github-test:tier1-scope',
    Record<string, unknown>,
    Record<string, unknown>,
    Record<string, unknown>,
    'scope'
  > {
  /** Discriminant for the test Tier-1 scope fixture. */
  readonly type: 'github-test:tier1-scope';
}

declare module '@harness-dsl/core' {
  /**
   * Augments `CustomDomainASTRegistry` with the test-only `'scope:github-test'` Tier-1 scope fixture.
   *
   * Enables `H.flow(...).scope(...)` composition tests inside `@harness-dsl/github` test suites.
   */
  interface CustomDomainASTRegistry {
    /** Test-only Tier-1 scope fixture entry for `@harness-dsl/github`. */
    readonly 'scope:github-test': GithubTestTier1ScopeNode;
  }
}
