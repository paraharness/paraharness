import type { BaseCheckASTNode } from '../base/base-check-ast-node.js';
import type { BaseDomainStepASTNode } from '../base/base-domain-step-ast-node.js';
import type { GitWorktreeHandle } from './git-worktree-handle.js';

/**
 * Passive AST node executing cumulative batch merge-train verification (`git.mergeQueue`).
 *
 * Combines up to `maxBatchSize` approved run branches onto `targetBranch`, verifies the cumulative
 * merge head with `verifyWith`, and bisects on batch verification failure.
 *
 * @template TIn  Validated step input type.
 * @template TOut Validated step output type.
 */
export interface GitMergeQueueNode<TIn = unknown, TOut = unknown>
  extends BaseDomainStepASTNode<'git:merge-queue', TIn, TOut, GitWorktreeHandle> {
  /** Target upstream branch into which approved runs are merged. */
  readonly targetBranch: string;
  /** Maximum number of runs combined into a single speculative verification batch. */
  readonly maxBatchSize: number;
  /** Deterministic verification check executed against the cumulative merge head. */
  readonly verifyWith: BaseCheckASTNode<string, GitWorktreeHandle>;
}
