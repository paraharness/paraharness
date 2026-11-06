import type { BaseIsolationScopeASTNode } from '../../src/ast/base/base-isolation-scope-ast-node.js';

/**
 * Custom Tier-1 (`capabilityTier: 'scope'`) isolation scope AST node registered via exact key `'scope'`.
 *
 * Used in unit tests to verify static build-time rejections when branching or checkpoint-dependent
 * actors are mounted onto a basic non-checkpointable scope.
 */
export interface SampleTier1ScopeNode
  extends BaseIsolationScopeASTNode<
    'sample:tier1-scope',
    { readonly rootDir: string },
    { readonly headSha: string },
    Record<string, unknown>,
    'scope'
  > {
  /** Root directory path of the basic scope. */
  readonly rootDir: string;
}

declare module '../../src/ast/custom-domain-ast-registry.js' {
  /**
   * Augments `CustomDomainASTRegistry` with the exact-key `'scope'` Tier-1 scope fixture.
   *
   * Verifies that exact-key custom domain registrations merge into `IsolationScopeASTNode`.
   */
  interface CustomDomainASTRegistry {
    /** Exact-key registration for Tier-1 scope fixture. */
    readonly scope: SampleTier1ScopeNode;
  }
}
