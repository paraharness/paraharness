import {
  extractAST,
  type ASTNode,
  type GitCowWorktreeNode,
  type GitScopeReceipt,
  type GitSyncReceipt,
  type GitWorktreeHandle,
  type MaybeBuilder,
} from '@paraharness/core';
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
 * Creates a fluent `GitCowWorktreeBuilder` (`git.cowWorktree(options?)`).
 *
 * Defaults `repo` to `'.'` and `dir` to `'.paraharness/worktree'`, and validates that both are non-empty strings
 * at declaration time without performing any filesystem I/O.
 *
 * @param {GitCowWorktreeOptions} [options] - Optional repository path, worktree base directory, and builder state.
 *
 * @returns {GitCowWorktreeBuilder} Immutable fluent worktree scope builder.
 *
 * @throws {Error} If `options.repo` or `options.dir` is empty.
 */
export function createGitCowWorktreeBuilder(
  options?: GitCowWorktreeOptions,
): GitCowWorktreeBuilder {
  const repo = options?.repo ?? '.';
  const dir = options?.dir ?? '.paraharness/worktree';
  if (repo.trim().length === 0) {
    throw new Error("git.cowWorktree: 'repo' must be a non-empty repository path.");
  }
  if (dir.trim().length === 0) {
    throw new Error("git.cowWorktree: 'dir' must be a non-empty worktree base directory.");
  }
  const resolvedOptions: GitCowWorktreeOptions = {
    ...options,
    repo,
    dir,
  };
  return Object.freeze<GitCowWorktreeBuilder>({
    excludeFromCloneGlobs(globs: readonly string[]): GitCowWorktreeBuilder {
      return createGitCowWorktreeBuilder({
        ...resolvedOptions,
        excludeFromCloneGlobs: Object.freeze([...globs]),
      });
    },
    setup(...commands: ReadonlyArray<MaybeBuilder<ASTNode>>): GitCowWorktreeBuilder {
      const nextSetup: ASTNode[] = [...(resolvedOptions.setupCommands ?? [])];
      for (const command of commands) {
        nextSetup.push(extractAST(command));
      }
      return createGitCowWorktreeBuilder({
        ...resolvedOptions,
        setupCommands: Object.freeze(nextSetup),
      });
    },
    lockfileGate(lockfilePath: string): GitCowWorktreeBuilder {
      if (lockfilePath.trim().length === 0) {
        throw new Error("git.cowWorktree.lockfileGate: 'lockfilePath' must be non-empty.");
      }
      return createGitCowWorktreeBuilder({
        ...resolvedOptions,
        lockfileGatePath: lockfilePath,
      });
    },
    checkpointPolicy(policy: GitCowWorktreeCheckpointPolicy): GitCowWorktreeBuilder {
      return createGitCowWorktreeBuilder({
        ...resolvedOptions,
        checkpointPolicy: policy,
      });
    },
    reconcileStrategy(
      modeOrOptions: 'rebase-onto-base' | 'batch-merge-train' | GitReconcileStrategyOptions,
      strategyOptions?: GitReconcileStrategyOptions,
    ): GitCowWorktreeBuilder {
      return createGitCowWorktreeBuilder({
        ...resolvedOptions,
        reconcileStrategy: resolveReconcileStrategyConfig(modeOrOptions, strategyOptions),
      });
    },
    toAST(): GitCowWorktreeNode<GitWorktreeHandle, GitScopeReceipt, GitSyncReceipt> {
      return buildGitCowWorktreeNode(resolvedOptions);
    },
  });
}
