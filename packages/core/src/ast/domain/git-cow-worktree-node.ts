import type { ASTNode } from '../ast-node.js';
import type { BaseCheckASTNode } from '../base/base-check-ast-node.js';
import type { BaseIsolationScopeASTNode } from '../base/base-isolation-scope-ast-node.js';
import type { FsPartitionMapNode } from './fs-partition-map-node.js';
import type { GitCleanWorkingTreeNode } from './git-clean-working-tree-node.js';
import type { GitScopeReceipt } from './git-scope-receipt.js';
import type { GitSyncReceipt } from './git-sync-receipt.js';
import type { GitWorktreeHandle } from './git-worktree-handle.js';

/**
 * Passive AST node configuring a Tier-3 branchable Copy-on-Write Git worktree scope (`git.cowWorktree`).
 *
 * Provides isolated root and child worktrees, dirty-index checkpointing without mutating `HEAD`,
 * 3-way child/root reconciliation, and automatic conflict cleanliness verification.
 *
 * @template THandle  Worktree scope handle type.
 * @template TReceipt Validated scope inspection receipt type.
 * @template TSync    Validated scope synchronization receipt type.
 */
export interface GitCowWorktreeNode<
  THandle = GitWorktreeHandle,
  TReceipt extends Record<string, unknown> = GitScopeReceipt,
  TSync extends Record<string, unknown> = GitSyncReceipt,
> extends BaseIsolationScopeASTNode<
    'git:cow-worktree',
    THandle,
    TReceipt,
    TSync,
    'branchable'
  > {
  /** Path to the host Git repository. */
  readonly repo: string;
  /** Base directory under which `roots/<runId>` and `forks/<runId>/<forkId>` worktrees are created. */
  readonly dir: string;
  /** Ordered setup step AST nodes executed when initializing a root worktree. */
  readonly setupCommands: readonly ASTNode[];
  /** Optional lockfile path whose digest gates whether `setupCommands` can be skipped. */
  readonly lockfileGatePath?: string;
  /** Optional glob patterns excluded when cloning dirty working-tree files into a worktree. */
  readonly excludeFromCloneGlobs?: readonly string[];
  /** Optional dirty-index checkpointing configuration. */
  readonly checkpointPolicy?: {
    /** Optional filesystem partition map associated with the checkpoint policy. */
    readonly partitionMap?: FsPartitionMapNode<string>;
    /** Optional glob patterns excluded from dirty-tree checkpoint snapshots. */
    readonly excludeGlobs?: readonly string[];
    /** Maximum file size in bytes staged directly into the temporary git index before spilling to `harness-ckpt-blobs/`. */
    readonly maxUntrackedFileSizeBytes?: number;
  };
  /** Optional branch landing reconciliation strategy (`'rebase-onto-base'` or `'batch-merge-train'`). */
  readonly reconcileStrategy?: {
    /** Reconciliation mode. */
    readonly mode: 'rebase-onto-base' | 'batch-merge-train';
    /** Optional verification check executed after rebasing onto the target base branch. */
    readonly verifyWith?: BaseCheckASTNode<string, THandle>;
    /** Optional maximum cumulative batch size for `'batch-merge-train'`. */
    readonly maxBatchSize?: number;
  };
  /** Built-in conflict cleanliness check enforced after conflicted merges or rebases. */
  readonly conflictCleanCheck: GitCleanWorkingTreeNode<THandle>;
}
