import type { BaseQuotaTripwireASTNode } from '../base/base-quota-tripwire-ast-node.js';

/**
 * Passive AST node tripping when distinct mutated file paths in a session exceed `maxFilesMutated` (`fs.maxFilesMutated`).
 *
 * Evaluated post-flight after each allowed tool execution to trigger `PolicyNode.onLimitExceeded`
 * when an actor mutates more files than permitted.
 */
export interface FsQuotaTripwireNode extends BaseQuotaTripwireASTNode<'fs:quota-tripwire'> {
  /** Maximum distinct mutated file paths allowed before tripping `.onLimitExceeded()`. */
  readonly maxFilesMutated: number;
}
