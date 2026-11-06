import type { BaseCrossVerifierASTNode } from '../base/base-cross-verifier-ast-node.js';
import type { FsPartitionMapNode } from './fs-partition-map-node.js';
import type { GitScopeReceipt } from './git-scope-receipt.js';
import type { GitWorktreeHandle } from './git-worktree-handle.js';
import type { NodeRunnerNode } from './node-runner-node.js';

/**
 * Passive AST node cross-executing boundary-only tests across speculative worktree candidates (`git.publicSurfaceCrossTester`).
 *
 * Transplants each candidate branch's public `boundaryGlobs` tests against every other candidate's
 * implementation to surface behavioral divergences prior to arbitration.
 *
 * @template TCrossReport Validated cross-verification report type.
 */
export interface GitPublicSurfaceCrossTesterNode<TCrossReport = Record<string, unknown>>
  extends BaseCrossVerifierASTNode<
    'git:public-surface-cross-tester',
    GitWorktreeHandle,
    GitScopeReceipt,
    TCrossReport
  > {
  /** Runner pool governing subprocess slot concurrency during cross-testing. */
  readonly runner: NodeRunnerNode;
  /** Filesystem partition map defining public `boundaryGlobs` per partition. */
  readonly partitionMap: FsPartitionMapNode<string>;
}
