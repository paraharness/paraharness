import type { BasePolicyGuardASTNode } from '../base/base-policy-guard-ast-node.js';

/**
 * Passive AST node scanning proposed file writes for hardcoded secret literals (`fs.secretLiterals`).
 *
 * Inspects pre-flight and post-flight file write contents against built-in and optional custom
 * secret regex patterns before allowing mutations.
 */
export interface FsSecretLiteralsGuardNode extends BasePolicyGuardASTNode<'fs:secret-literals'> {
  /** Optional custom regex pattern strings for secret detection. */
  readonly patterns?: readonly string[];
}
