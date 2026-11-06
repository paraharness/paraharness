import type { BasePolicyGuardASTNode } from '../base/base-policy-guard-ast-node.js';

/**
 * Passive AST node protecting specific glob patterns from write mutations (`fs.protect`).
 *
 * Blocks any pre-flight or post-flight write effect matching `globs` unless explicitly
 * covered by an elevated capability lease.
 */
export interface FsProtectGuardNode extends BasePolicyGuardASTNode<'fs:protect'> {
  /** Protected file glob patterns. */
  readonly globs: readonly string[];
}
