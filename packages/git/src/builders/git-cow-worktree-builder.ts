import type {
  ASTNode,
  AstBuilder,
  GitCowWorktreeNode,
  GitScopeReceipt,
  GitSyncReceipt,
  GitWorktreeHandle,
  MaybeBuilder,
} from '@metaharness/core';
import type { GitCowWorktreeCheckpointPolicy } from './git-cow-worktree-options.js';
import type { GitReconcileStrategyOptions } from './git-reconcile-strategy-options.js';

/**
 * Fluent builder for a Tier-3 branchable Copy-on-Write Git worktree scope (`git.cowWorktree`).
 *
 * Compiles into a passive `GitCowWorktreeNode` (`type: 'git:cow-worktree'`, `capabilityTier: 'branchable'`)
 * with zero filesystem or subprocess I/O at builder declaration time.
 */
export interface GitCowWorktreeBuilder
  extends AstBuilder<GitCowWorktreeNode<GitWorktreeHandle, GitScopeReceipt, GitSyncReceipt>> {
  /**
   * Configures glob patterns excluded when cloning dirty working-tree files or caches into a worktree.
   *
   * Returns a new immutable `GitCowWorktreeBuilder` instance with `excludeFromCloneGlobs` set to a frozen copy of `globs`.
   *
   * @param {readonly string[]} globs - Repository-relative glob patterns to omit during worktree cloning.
   *
   * @returns {GitCowWorktreeBuilder} Updated immutable worktree builder instance.
   */
  excludeFromCloneGlobs(globs: readonly string[]): GitCowWorktreeBuilder;

  /**
   * Appends one or more setup command steps executed when provisioning a root worktree on a lockfile gate miss.
   *
   * Accepts either raw `ASTNode` descriptors or fluent `AstBuilder<ASTNode>` instances (such as `local.command(...)`).
   *
   * @param {...Array<MaybeBuilder<ASTNode>>} commands - Setup command steps to execute in declaration order.
   *
   * @returns {GitCowWorktreeBuilder} Updated immutable worktree builder instance.
   */
  setup(...commands: ReadonlyArray<MaybeBuilder<ASTNode>>): GitCowWorktreeBuilder;

  /**
   * Configures a lockfile path whose SHA-256 digest gates whether `.setup()` commands can be skipped.
   *
   * On a lockfile hash hit against the host repository, `node_modules` is CoW-cloned/hardlinked; on a miss,
   * any hardlinked `node_modules` tree is unlinked and replaced before executing `.setup()` commands.
   *
   * @param {string} lockfilePath - Repository-relative path to the dependency lockfile (such as `'pnpm-lock.yaml'`).
   *
   * @returns {GitCowWorktreeBuilder} Updated immutable worktree builder instance.
   */
  lockfileGate(lockfilePath: string): GitCowWorktreeBuilder;

  /**
   * Configures dirty-index checkpointing exclusions, partition mapping, and untracked blob size limits.
   *
   * Controls how `serializeCheckpoint`, `diffEffects`, and `restoreCheckpoint` stage tracked and untracked files.
   *
   * @param {GitCowWorktreeCheckpointPolicy} policy - Checkpoint policy configuration.
   *
   * @returns {GitCowWorktreeBuilder} Updated immutable worktree builder instance.
   */
  checkpointPolicy(policy: GitCowWorktreeCheckpointPolicy): GitCowWorktreeBuilder;

  /**
   * Configures the branch landing reconciliation strategy (`'rebase-onto-base'` or `'batch-merge-train'`).
   *
   * Accepts either `(mode, options?)` positional arguments or a single `GitReconcileStrategyOptions` object.
   *
   * @param {'rebase-onto-base' | 'batch-merge-train' | GitReconcileStrategyOptions} modeOrOptions - Reconciliation mode or options object.
   * @param {GitReconcileStrategyOptions}                                            [options]     - Optional verification check and batch size settings.
   *
   * @returns {GitCowWorktreeBuilder} Updated immutable worktree builder instance.
   */
  reconcileStrategy(
    modeOrOptions: 'rebase-onto-base' | 'batch-merge-train' | GitReconcileStrategyOptions,
    options?: GitReconcileStrategyOptions,
  ): GitCowWorktreeBuilder;
}
