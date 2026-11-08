import {
  extractAST,
  type ASTNode,
  type GitCowWorktreeNode,
  type GitScopeReceipt,
  type GitSyncReceipt,
  type GitWorktreeHandle,
  type MaybeBuilder,
} from '@metaharness/core';
import type { GitCowWorktreeBuilder } from './git-cow-worktree-builder.js';
import type {
  GitCowWorktreeCheckpointPolicy,
  GitCowWorktreeOptions,
} from './git-cow-worktree-options.js';
import type { GitReconcileStrategyOptions } from './git-reconcile-strategy-options.js';
import {
  buildGitCowWorktreeNode,
  resolveReconcileStrategyConfig,
} from './internal/build-git-cow-worktree-node.js';

/**
 * Creates a fluent `GitCowWorktreeBuilder` (`git.cowWorktree({ repo, dir })`).
 *
 * Validates that `repo` and `dir` are non-empty strings at declaration time without performing any filesystem I/O.
 *
 * @param {GitCowWorktreeOptions} options - Repository path, worktree base directory, and optional builder state.
 *
 * @returns {GitCowWorktreeBuilder} Immutable fluent worktree scope builder.
 *
 * @throws {Error} If `options.repo` or `options.dir` is empty.
 */
export function createGitCowWorktreeBuilder(
  options: GitCowWorktreeOptions,
): GitCowWorktreeBuilder {
  if (options.repo.trim().length === 0) {
    throw new Error("git.cowWorktree: 'repo' must be a non-empty repository path.");
  }
  if (options.dir.trim().length === 0) {
    throw new Error("git.cowWorktree: 'dir' must be a non-empty worktree base directory.");
  }
  return Object.freeze<GitCowWorktreeBuilder>({
    excludeFromCloneGlobs(globs: readonly string[]): GitCowWorktreeBuilder {
      return createGitCowWorktreeBuilder({
        ...options,
        excludeFromCloneGlobs: Object.freeze([...globs]),
      });
    },
    setup(...commands: ReadonlyArray<MaybeBuilder<ASTNode>>): GitCowWorktreeBuilder {
      const nextSetup: ASTNode[] = [...(options.setupCommands ?? [])];
      for (const command of commands) {
        nextSetup.push(extractAST(command));
      }
      return createGitCowWorktreeBuilder({
        ...options,
        setupCommands: Object.freeze(nextSetup),
      });
    },
    lockfileGate(lockfilePath: string): GitCowWorktreeBuilder {
      if (lockfilePath.trim().length === 0) {
        throw new Error("git.cowWorktree.lockfileGate: 'lockfilePath' must be non-empty.");
      }
      return createGitCowWorktreeBuilder({
        ...options,
        lockfileGatePath: lockfilePath,
      });
    },
    checkpointPolicy(policy: GitCowWorktreeCheckpointPolicy): GitCowWorktreeBuilder {
      return createGitCowWorktreeBuilder({
        ...options,
        checkpointPolicy: policy,
      });
    },
    reconcileStrategy(
      modeOrOptions: 'rebase-onto-base' | 'batch-merge-train' | GitReconcileStrategyOptions,
      strategyOptions?: GitReconcileStrategyOptions,
    ): GitCowWorktreeBuilder {
      return createGitCowWorktreeBuilder({
        ...options,
        reconcileStrategy: resolveReconcileStrategyConfig(modeOrOptions, strategyOptions),
      });
    },
    toAST(): GitCowWorktreeNode<GitWorktreeHandle, GitScopeReceipt, GitSyncReceipt> {
      return buildGitCowWorktreeNode(options);
    },
  });
}
