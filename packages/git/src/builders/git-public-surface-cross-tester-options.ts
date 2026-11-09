import type {
  FsPartitionMapNode,
  MaybeBuilder,
  NodeRunnerNode,
} from '@paraharness/core';

/**
 * Configuration options for `git.publicSurfaceCrossTester(options)` (`createGitPublicSurfaceCrossTesterBuilder`).
 *
 * Binds the subprocess `runner` pool and `partitionMap` whose `boundaryGlobs` identify public surface
 * contracts for cross-candidate test transplantation.
 */
export interface GitPublicSurfaceCrossTesterOptions {
  /** Optional unique identifier for the cross-verifier node (defaults to `'git-public-surface-cross-tester'`). */
  readonly id?: string;
  /** Optional runner pool governing subprocess slot concurrency during cross-testing (defaults to `DEFAULT_NODE_RUNNER_AST_NODE`). */
  readonly runner?: MaybeBuilder<NodeRunnerNode>;
  /** Filesystem partition map defining public `boundaryGlobs` per partition. */
  readonly partitionMap: MaybeBuilder<FsPartitionMapNode<string>>;
}
