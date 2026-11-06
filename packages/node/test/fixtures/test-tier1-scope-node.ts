import type { BaseIsolationScopeASTNode } from '@harness-dsl/core';

/**
 * Test-only Tier-1 (`capabilityTier: 'scope'`) isolation scope AST node for `@harness-dsl/node` typechecking.
 *
 * Augments `CustomDomainASTRegistry` so `IsolationScopeASTNode['capabilityTier']` covers the full
 * `'scope' | 'checkpointable' | 'branchable'` union during standalone package typechecking.
 */
export interface NodeTestTier1ScopeNode
  extends BaseIsolationScopeASTNode<
    'node-test:tier1-scope',
    { readonly worktreePath?: string },
    Record<string, unknown>,
    Record<string, unknown>,
    'scope'
  > {
  /** Optional worktree directory path for testing subprocess isolation. */
  readonly worktreePath?: string;
}

declare module '@harness-dsl/core' {
  /**
   * Augments `CustomDomainASTRegistry` with `NodeTestTier1ScopeNode` under `'scope:node-test'`.
   *
   * Preserves full `ScopeCapabilityTier` union coverage across `@harness-dsl/core` flow validators.
   */
  interface CustomDomainASTRegistry {
    /** Test-only Tier-1 scope registration. */
    readonly 'scope:node-test': NodeTestTier1ScopeNode;
  }
}
