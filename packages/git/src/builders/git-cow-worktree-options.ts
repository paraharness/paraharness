import type {
  ASTNode,
  FsPartitionMapNode,
  GitCleanWorkingTreeNode,
  GitReconcileStrategyConfig,
  GitWorktreeHandle,
  MaybeBuilder,
} from '@paraharness/core';

/**
 * Dirty-index checkpointing configuration accepted by `GitCowWorktreeBuilder.checkpointPolicy()`.
 *
 * Controls which partition map and glob exclusions apply when snapshotting or diffing a worktree,
 * and sets the byte ceiling above which untracked files spill into `<gitdir>/harness-ckpt-blobs/`.
 */
export interface GitCowWorktreeCheckpointPolicy {
  /** Optional filesystem partition map associated with the checkpoint policy. */
  readonly partitionMap?: MaybeBuilder<FsPartitionMapNode<string>>;
  /** Optional glob patterns excluded from dirty-tree checkpoint snapshots. */
  readonly excludeGlobs?: readonly string[];
  /** Maximum file size in bytes staged directly into the temporary git index before spilling to `harness-ckpt-blobs/`. */
  readonly maxUntrackedFileSizeBytes?: number;
}

/**
 * Configuration options for `git.cowWorktree(options)` (`createGitCowWorktreeBuilder`).
 *
 * Specifies the host Git repository root (`repo`), the disjoint sibling workspace directory (`dir`),
 * and optional pre-populated builder state fields for immutable builder chaining.
 */
export interface GitCowWorktreeOptions {
  /** Optional logical identifier for the isolation scope node (defaults to `'git-cow-worktree'`). */
  readonly id?: string;
  /** Path to the host Git repository. */
  readonly repo: string;
  /** Base directory under which `roots/<runId>` and `forks/<runId>/<forkId>` worktrees are created. */
  readonly dir: string;
  /** Optional ordered setup step AST nodes executed when initializing a root worktree. */
  readonly setupCommands?: readonly ASTNode[];
  /** Optional lockfile path whose SHA-256 digest gates whether `setupCommands` can be skipped. */
  readonly lockfileGatePath?: string;
  /** Optional glob patterns excluded when cloning dirty working-tree files into a worktree. */
  readonly excludeFromCloneGlobs?: readonly string[];
  /** Optional dirty-index checkpointing configuration. */
  readonly checkpointPolicy?: GitCowWorktreeCheckpointPolicy;
  /** Optional branch landing reconciliation strategy (`'rebase-onto-base'` or `'batch-merge-train'`). */
  readonly reconcileStrategy?: GitReconcileStrategyConfig<GitWorktreeHandle>;
  /** Optional custom conflict cleanliness check node overriding the default `git:clean-working-tree` check. */
  readonly conflictCleanCheck?: GitCleanWorkingTreeNode<GitWorktreeHandle>;
}
