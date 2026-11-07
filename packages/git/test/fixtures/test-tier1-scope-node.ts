import type { BaseIsolationScopeASTNode } from '@harness-dsl/core';

/**
 * Test-only Tier-1 (`capabilityTier: 'scope'`) isolation scope AST node for standalone `@harness-dsl/git` typechecking.
 *
 * Augments `CustomDomainASTRegistry` so `IsolationScopeASTNode['capabilityTier']` covers the full
 * `'scope' | 'checkpointable' | 'branchable'` union during standalone package typechecking.
 */
export interface GitTestTier1ScopeNode
  extends BaseIsolationScopeASTNode<
    'git-test:tier1-scope',
    Record<string, unknown>,
    Record<string, unknown>,
    Record<string, unknown>,
    'scope'
  > {
  /** Root directory path for the test scope. */
  readonly rootDir: string;
}

declare module '@harness-dsl/core' {
  /**
   * Augments `CustomDomainASTRegistry` with `GitTestTier1ScopeNode` under `'scope:git-test'`.
   *
   * Preserves full `ScopeCapabilityTier` union coverage across `@harness-dsl/core` flow validators.
   */
  interface CustomDomainASTRegistry {
    /** Test-only Tier-1 scope registration. */
    readonly 'scope:git-test': GitTestTier1ScopeNode;
  }
}
