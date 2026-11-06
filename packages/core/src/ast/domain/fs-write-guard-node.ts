import type { BasePolicyGuardASTNode } from '../base/base-policy-guard-ast-node.js';

/**
 * Passive AST node enforcing glob-based write allow/deny rules (`fs.writeGuard`).
 *
 * Projects `violatedEffects` strictly to paths matching `denyGlobs` and not covered by
 * `allowGlobs` or active `LeaseDelta` grants.
 */
export interface FsWriteGuardNode extends BasePolicyGuardASTNode<'fs:write-guard'> {
  /** Glob patterns denying write mutations. */
  readonly denyGlobs: readonly string[];
  /** Optional glob patterns exempted from `denyGlobs`. */
  readonly allowGlobs?: readonly string[];
  /** When `true`, blocks only paths that already existed at `handle.baseRef`. */
  readonly onlyExistingAtBaseRef?: boolean;
}
