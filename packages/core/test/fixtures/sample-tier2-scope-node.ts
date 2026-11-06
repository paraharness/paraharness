import type {
  BaseIsolationScopeASTNode,
  GitScopeReceipt,
  GitSyncReceipt,
  GitWorktreeHandle,
} from '../../src/index.js';

/**
 * Custom Tier-2 (`capabilityTier: 'checkpointable'`) isolation scope AST node registered via namespaced key `'scope:tier2'`.
 *
 * Used in unit tests to verify that checkpointable scopes support post-flight rollback but reject
 * branching capabilities (`.fork()`, `.speculate()`, `.mutatePlan()`).
 */
export interface SampleTier2ScopeNode
  extends BaseIsolationScopeASTNode<
    'sample:tier2-scope',
    GitWorktreeHandle,
    GitScopeReceipt,
    GitSyncReceipt,
    'checkpointable'
  > {
  /** Snapshot directory path of the checkpointable scope. */
  readonly snapshotDir: string;
}

declare module '../../src/ast/custom-domain-ast-registry.js' {
  /**
   * Augments `CustomDomainASTRegistry` with the namespaced `'scope:tier2'` Tier-2 scope fixture.
   *
   * Verifies that namespaced `${K}:${string}` custom domain registrations merge without key collision.
   */
  interface CustomDomainASTRegistry {
    /** Namespaced-key registration for Tier-2 checkpointable scope fixture. */
    readonly 'scope:tier2': SampleTier2ScopeNode;
  }
}
