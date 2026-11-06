import type { BasePolicyGuardASTNode } from '../base/base-policy-guard-ast-node.js';

/**
 * Passive AST node restricting filesystem writes strictly to an allowlist of globs (`fs.allowOnly`).
 *
 * Rejects any write effect whose normalized repository-relative path does not match at least
 * one glob pattern in `globs` (or an active `LeaseDelta` grant).
 */
export interface FsAllowOnlyGuardNode extends BasePolicyGuardASTNode<'fs:allow-only'> {
  /** Allowed write glob patterns. */
  readonly globs: readonly string[];
}
