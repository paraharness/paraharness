import {
  extractAST,
  type GitCleanWorkingTreeNode,
  type GitCowWorktreeNode,
  type GitReconcileStrategyConfig,
  type GitScopeReceipt,
  type GitSyncReceipt,
  type GitWorktreeHandle,
} from '@paraharness/core';
import { GitScopeReceiptSchema, GitSyncReceiptSchema } from '../../schemas/git-receipts.schema.js';
import type {
  GitCowWorktreeCheckpointPolicy,
  GitCowWorktreeOptions,
} from '../git-cow-worktree-options.js';
import type { GitReconcileStrategyOptions } from '../git-reconcile-strategy-options.js';

/**
 * Normalizes positional or object `.reconcileStrategy(...)` arguments into a frozen `GitReconcileStrategyConfig`.
 *
 * Extracts any `AstBuilder` passed as `verifyWith` into its passive `BaseCheckASTNode` representation.
 *
 * @param {'rebase-onto-base' | 'batch-merge-train' | GitReconcileStrategyOptions} modeOrOptions - Mode literal or options object.
 * @param {GitReconcileStrategyOptions}                                            [options]     - Optional secondary options when first arg is mode.
 *
 * @returns {GitReconcileStrategyConfig<GitWorktreeHandle>} Frozen reconciliation strategy AST configuration.
 */
export function resolveReconcileStrategyConfig(
  modeOrOptions: 'rebase-onto-base' | 'batch-merge-train' | GitReconcileStrategyOptions,
  options?: GitReconcileStrategyOptions,
): GitReconcileStrategyConfig<GitWorktreeHandle> {
  const mode =
    typeof modeOrOptions === 'string'
      ? modeOrOptions
      : (modeOrOptions.mode ?? 'rebase-onto-base');
  const mergedOptions = typeof modeOrOptions === 'string' ? options : modeOrOptions;
  const verifyWith =
    mergedOptions?.verifyWith !== undefined ? extractAST(mergedOptions.verifyWith) : undefined;
  return Object.freeze<GitReconcileStrategyConfig<GitWorktreeHandle>>({
    mode,
    verifyWith,
    maxBatchSize: mergedOptions?.maxBatchSize,
  });
}

/**
 * Compiles optional `GitCowWorktreeCheckpointPolicy` builder options into a frozen AST checkpoint policy object.
 *
 * Unwraps `partitionMap` via `extractAST` and freezes `excludeGlobs` when present.
 *
 * @param {GitCowWorktreeCheckpointPolicy | undefined} policy - Builder checkpoint policy configuration.
 *
 * @returns {GitCowWorktreeNode['checkpointPolicy']} Frozen checkpoint policy AST configuration or `undefined`.
 */
export function buildCheckpointPolicyConfig(
  policy: GitCowWorktreeCheckpointPolicy | undefined,
): GitCowWorktreeNode['checkpointPolicy'] {
  if (policy === undefined) return undefined;
  return Object.freeze({
    partitionMap: policy.partitionMap !== undefined ? extractAST(policy.partitionMap) : undefined,
    excludeGlobs:
      policy.excludeGlobs !== undefined ? Object.freeze([...policy.excludeGlobs]) : undefined,
    maxUntrackedFileSizeBytes: policy.maxUntrackedFileSizeBytes,
  });
}

/**
 * Compiles `GitCowWorktreeOptions` into an immutable, monomorphic `GitCowWorktreeNode` AST object.
 *
 * Populates default `conflictCleanCheck`, `receiptSchema`, and `syncSchema` fields while preserving V8 hidden classes.
 *
 * @param {GitCowWorktreeOptions} options - Accumulated builder configuration.
 *
 * @returns {GitCowWorktreeNode<GitWorktreeHandle, GitScopeReceipt, GitSyncReceipt>} Frozen `GitCowWorktreeNode` AST descriptor.
 */
export function buildGitCowWorktreeNode(
  options: GitCowWorktreeOptions,
): GitCowWorktreeNode<GitWorktreeHandle, GitScopeReceipt, GitSyncReceipt> {
  const defaultCleanCheck = Object.freeze<GitCleanWorkingTreeNode<GitWorktreeHandle>>({
    type: 'git:clean-working-tree',
    id: 'git-clean-working-tree',
  });
  return Object.freeze<GitCowWorktreeNode<GitWorktreeHandle, GitScopeReceipt, GitSyncReceipt>>({
    type: 'git:cow-worktree',
    id: options.id ?? 'git-cow-worktree',
    capabilityTier: 'branchable',
    supportsCheckpoints: true,
    supportsBranching: true,
    receiptSchema: GitScopeReceiptSchema,
    syncSchema: GitSyncReceiptSchema,
    repo: options.repo,
    dir: options.dir,
    setupCommands: Object.freeze([...(options.setupCommands ?? [])]),
    lockfileGatePath: options.lockfileGatePath,
    excludeFromCloneGlobs:
      options.excludeFromCloneGlobs !== undefined
        ? Object.freeze([...options.excludeFromCloneGlobs])
        : undefined,
    checkpointPolicy: buildCheckpointPolicyConfig(options.checkpointPolicy),
    reconcileStrategy: options.reconcileStrategy,
    conflictCleanCheck: options.conflictCleanCheck ?? defaultCleanCheck,
  });
}
