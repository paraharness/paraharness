import type { BasePolicyGuardASTNode } from '../base/base-policy-guard-ast-node.js';

/**
 * Passive AST node restricting subprocess execution to an explicit allowlist of binary names (`local.allowBinaries`).
 *
 * Inspects `ProcessToolEffect` binary names pre-flight and blocks any subprocess command whose
 * executable is not listed in `binaries`.
 */
export interface NodeAllowBinariesNode extends BasePolicyGuardASTNode<'node:allow-binaries'> {
  /** Allowed executable binary names. */
  readonly binaries: readonly string[];
}
