import type { BaseCheckASTNode, GitWorktreeHandle, MaybeBuilder } from '@harness-dsl/core';

/**
 * Options for configuring branch landing reconciliation via `GitCowWorktreeBuilder.reconcileStrategy()`.
 *
 * Supports both `'rebase-onto-base'` (for PR-opening lanes) and `'batch-merge-train'` (for cumulative
 * speculative merge queues), optionally binding a post-rebase verification check and maximum batch size.
 */
export interface GitReconcileStrategyOptions {
  /** Reconciliation mode when passed via the single-object `.reconcileStrategy(options)` overload. */
  readonly mode?: 'rebase-onto-base' | 'batch-merge-train';
  /** Optional deterministic check executed after rebasing onto the target base branch. */
  readonly verifyWith?: MaybeBuilder<BaseCheckASTNode<string, GitWorktreeHandle>>;
  /** Optional maximum cumulative batch size when using `'batch-merge-train'`. */
  readonly maxBatchSize?: number;
}
