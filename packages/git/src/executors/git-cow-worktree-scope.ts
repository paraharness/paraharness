import type {
  BranchableScope,
  GitCowWorktreeNode,
  GitScopeReceipt,
  GitSyncReceipt,
  GitWorktreeHandle,
  LeaseDelta,
  ReconcileResult,
  ToolEffect,
} from '@paraharness/core';
import PQueue from 'p-queue';
import {
  GitScopeReceiptSchema,
  GitSyncReceiptSchema,
} from '../schemas/git-receipts.schema.js';
import { gitCheckpointDiffEffects } from './internal/git-checkpoint-diff-effects.js';
import { gitCheckpointRestore } from './internal/git-checkpoint-restore.js';
import { gitCheckpointSerialize } from './internal/git-checkpoint-serialize.js';
import { gitWorktreeAcquireRoot } from './internal/git-worktree-acquire-root.js';
import {
  gitWorktreeCommitChild,
  gitWorktreeInspectNonMutating,
} from './internal/git-worktree-commit-child.js';
import {
  buildConflictLeaseDelta,
  gitWorktreeFlushCleanParentChanges,
} from './internal/git-worktree-flush-and-prune.js';
import {
  gitWorktreeForkChild,
  gitWorktreeReleaseAndPinRef,
} from './internal/git-worktree-fork-and-release.js';
import {
  gitWorktreeReattachChild,
  gitWorktreeReattachRoot,
  resolveEffectiveCheckpointPolicy,
} from './internal/git-worktree-reattach.js';
import {
  gitWorktreeSyncChild,
  gitWorktreeSyncRoot,
} from './internal/git-worktree-sync-child-and-root.js';

/**
 * Tier-3 branchable Copy-on-Write Git worktree isolation scope driver (`git.cowWorktree`).
 *
 * Implements disjoint root/fork worktrees, git-index checkpoints, post-flight `.git` integrity diffing,
 * automatic parent dirty-tree flushing, and stateless `git merge-tree --write-tree` 3-way reconciliation.
 */
export class GitCowWorktreeScopeDriver
  implements BranchableScope<GitWorktreeHandle, GitScopeReceipt, GitSyncReceipt>
{
  /** Unique identifier of this isolation scope driver instance. */
  readonly id: string;
  /** Zod schema validating inspection receipts returned by `inspect()`. */
  readonly receiptSchema = GitScopeReceiptSchema;
  /** Zod schema validating synchronization receipts returned by `syncChild()` and `syncRoot()`. */
  readonly syncSchema = GitSyncReceiptSchema;
  /** Capability flag confirming git-index checkpoint serialization and rollback support. */
  readonly supportsCheckpoints = true as const;
  /** Capability flag confirming Copy-on-Write child worktree branching and 3-way reconciliation support. */
  readonly supportsBranching = true as const;
  /** Passive AST configuration node for this worktree scope. */
  private readonly node: GitCowWorktreeNode;
  /** Precomputed union of `node.excludeFromCloneGlobs` and `node.checkpointPolicy?.excludeGlobs`. */
  private readonly effectiveExcludeGlobs: readonly string[] | undefined;
  /** Precomputed checkpoint policy with merged `effectiveExcludeGlobs`. */
  private readonly effectiveCheckpointPolicy: GitCowWorktreeNode['checkpointPolicy'];
  /** Per-parent worktree `PQueue` (`concurrency: 1`) serializing automatic parent dirty-tree flushes during `forkChild`. */
  private readonly parentFlushQueues = new Map<string, PQueue>();

  /**
   * Initializes a `GitCowWorktreeScopeDriver` from its passive `GitCowWorktreeNode` AST configuration.
   *
   * Binds the repository path, disjoint worktree directory layout, and checkpoint policy configuration.
   *
   * @param {GitCowWorktreeNode} node - Passive worktree scope AST configuration node.
   */
  constructor(node: GitCowWorktreeNode) {
    this.id = node.id;
    this.node = node;
    this.effectiveCheckpointPolicy = resolveEffectiveCheckpointPolicy(node);
    this.effectiveExcludeGlobs = this.effectiveCheckpointPolicy?.excludeGlobs;
  }

  /**
   * Provisions an isolated Task Root Worktree at `<dir>/roots/<runId>` for `runId`.
   *
   * Hydrates `node_modules` according to `.lockfileGate` and `.setup` and initializes `<gitdir>/harness-meta.json`.
   *
   * @param {string} runId - Unique identifier of the flow run.
   *
   * @returns {Promise<GitWorktreeHandle>} Newly acquired root worktree handle.
   */
  acquireRoot(runId: string): Promise<GitWorktreeHandle> {
    return gitWorktreeAcquireRoot(this.node, runId);
  }

  /**
   * Rebinds an existing Task Root Worktree at `<dir>/roots/<runId>` during crash recovery.
   *
   * Completes interrupted `pendingParentHeadSha` or `inFlightMerge` state and rolls back `inFlightCommitAndPush`.
   *
   * @param {string} runId        - Unique identifier of the recovering flow run.
   * @param {string} [checkpoint] - Optional serialized checkpoint fallback when the worktree directory is missing.
   *
   * @returns {Promise<GitWorktreeHandle>} Reattached root worktree handle.
   */
  reattachRoot(runId: string, checkpoint?: string): Promise<GitWorktreeHandle> {
    return gitWorktreeReattachRoot(this.node, runId, checkpoint);
  }

  /**
   * Captures a non-mutating `GitScopeReceipt` for `handle` using a temporary `GIT_INDEX_FILE`.
   *
   * Pins `refs/harness/candidates/<run-id>/<branch-index>` when inspecting a speculative branch handle.
   *
   * @param {GitWorktreeHandle} handle - Active worktree handle to inspect.
   *
   * @returns {Promise<GitScopeReceipt>} Validated `GitScopeReceipt` without mutating live `HEAD` or `.git/index`.
   */
  inspect(handle: GitWorktreeHandle): Promise<GitScopeReceipt> {
    return gitWorktreeInspectNonMutating(handle, this.effectiveExcludeGlobs);
  }

  /**
   * Pins the final commit SHA under `refs/harness/completed/...` and removes the worktree directory.
   *
   * Prunes `<gitdir>/harness-ckpt-blobs/` and `<gitdir>/harness-ckpt-nm/` before `git worktree remove --force`.
   *
   * @param {GitWorktreeHandle} handle - Ephemeral root or child worktree handle to release.
   *
   * @returns {Promise<void>} Resolves once the completed ref is pinned and the worktree is removed.
   */
  release(handle: GitWorktreeHandle): Promise<void> {
    this.parentFlushQueues.delete(handle.worktreePath);
    return gitWorktreeReleaseAndPinRef(handle, this.effectiveExcludeGlobs);
  }

  /**
   * Captures the uncommitted working-tree and worktree-local `.git` state of `handle` into a JSON checkpoint token.
   *
   * Uses `git status --porcelain=v2 -z --no-renames --untracked-files=all` and a temporary `GIT_INDEX_FILE`.
   *
   * @param {GitWorktreeHandle} handle - Active worktree handle to snapshot.
   *
   * @returns {Promise<string>} Serialized JSON `GitCheckpointPayload` string.
   */
  serializeCheckpoint(handle: GitWorktreeHandle): Promise<string> {
    return gitCheckpointSerialize(handle, this.effectiveCheckpointPolicy);
  }

  /**
   * Restores `handle` to the exact state captured by `checkpoint` using the 4-step restoration protocol.
   *
   * Restores `.git` metadata and `.gitignore` rules, unlinks symmetric-diff extras, checks out `treeSha`, and copies back oversized blobs.
   *
   * @param {GitWorktreeHandle} handle     - Active worktree handle to roll back.
   * @param {string}            checkpoint - Serialized JSON checkpoint payload.
   *
   * @returns {Promise<void>} Resolves once `handle` matches `checkpoint`.
   */
  restoreCheckpoint(handle: GitWorktreeHandle, checkpoint: string): Promise<void> {
    return gitCheckpointRestore(handle, checkpoint, this.effectiveCheckpointPolicy);
  }

  /**
   * Verifies worktree-local `.git` and `node_modules` integrity and diffs `handle` against `fromCheckpoint`.
   *
   * Restores `fromCheckpoint` and throws immediately if `.git` metadata or `node_modules` was tampered with.
   *
   * @param {string}            fromCheckpoint - Pre-tool serialized checkpoint payload.
   * @param {GitWorktreeHandle} handle         - Worktree handle after subprocess tool execution.
   *
   * @returns {Promise<readonly ToolEffect[]>} Synthesized `FsToolEffect` list for modified paths.
   */
  diffEffects(fromCheckpoint: string, handle: GitWorktreeHandle): Promise<readonly ToolEffect[]> {
    return gitCheckpointDiffEffects(fromCheckpoint, handle, this.effectiveCheckpointPolicy);
  }

  /**
   * Returns or creates the serialized `PQueue` (`concurrency: 1`) for `parentWorktreePath`.
   *
   * @param {string} parentWorktreePath - Absolute path of the parent worktree.
   *
   * @returns {PQueue} Serialized parent flush queue for `parentWorktreePath`.
   */
  private getOrCreateParentFlushQueue(parentWorktreePath: string): PQueue {
    const existing = this.parentFlushQueues.get(parentWorktreePath);
    if (existing !== undefined) return existing;
    const created = new PQueue({ concurrency: 1 });
    this.parentFlushQueues.set(parentWorktreePath, created);
    return created;
  }

  /**
   * Removes `activeQueue` from `parentFlushQueues` once no tasks remain queued or running.
   *
   * @param {string} parentWorktreePath - Absolute path of the parent worktree.
   * @param {PQueue} activeQueue        - Queue instance that just completed a task.
   */
  private pruneIdleParentFlushQueue(parentWorktreePath: string, activeQueue: PQueue): void {
    if (
      activeQueue.size === 0 &&
      activeQueue.pending === 0 &&
      this.parentFlushQueues.get(parentWorktreePath) === activeQueue
    ) {
      this.parentFlushQueues.delete(parentWorktreePath);
    }
  }

  /**
   * Flushes clean dirty files on `parent` under a per-parent async mutex and forks `<dir>/forks/<runId>/<forkId>`.
   *
   * Copies any remaining `unresolvedConflictPaths` from `parent` into the newly forked child worktree.
   *
   * @param {GitWorktreeHandle} parent - Parent worktree handle to clone from.
   * @param {string}            forkId - Unique child fork or speculative branch identifier.
   *
   * @returns {Promise<GitWorktreeHandle>} Newly provisioned child worktree handle.
   */
  async forkChild(parent: GitWorktreeHandle, forkId: string): Promise<GitWorktreeHandle> {
    const excludeGlobs = this.effectiveExcludeGlobs;
    const activeQueue = this.getOrCreateParentFlushQueue(parent.worktreePath);
    try {
      await activeQueue.add(async (): Promise<void> => {
        await gitWorktreeFlushCleanParentChanges(parent, excludeGlobs);
      });
    } finally {
      this.pruneIdleParentFlushQueue(parent.worktreePath, activeQueue);
    }
    return gitWorktreeForkChild(this.node, parent, forkId);
  }

  /**
   * Rebinds an existing child fork worktree at `<dir>/forks/<runId>/<forkId>` during crash recovery.
   *
   * Completes any interrupted `inFlightMerge` state and preserves uncommitted child edits across reboots.
   *
   * @param {GitWorktreeHandle} parent       - Reattached parent worktree handle.
   * @param {string}            forkId       - Unique child fork identifier.
   * @param {string}            [checkpoint] - Optional serialized checkpoint fallback when the directory is missing.
   *
   * @returns {Promise<GitWorktreeHandle>} Reattached child worktree handle.
   */
  reattachChild(parent: GitWorktreeHandle, forkId: string, checkpoint?: string): Promise<GitWorktreeHandle> {
    return gitWorktreeReattachChild({
      node: this.node,
      parent,
      forkId,
      checkpoint,
    });
  }

  /**
   * Reconciles `child` into `parent` via stateless `git merge-tree --write-tree` over shared parent $C_0$.
   *
   * Leaves `parent` untouched on conflict and materializes conflicted blobs into `child` with `unresolvedConflictPaths`.
   *
   * @param {GitWorktreeHandle} child  - Completed child worktree handle.
   * @param {GitWorktreeHandle} parent - Target parent worktree handle.
   *
   * @returns {Promise<ReconcileResult<GitScopeReceipt>>} Clean or conflicted reconciliation result.
   */
  commitChild(child: GitWorktreeHandle, parent: GitWorktreeHandle): Promise<ReconcileResult<GitScopeReceipt>> {
    return gitWorktreeCommitChild(child, parent, this.effectiveExcludeGlobs);
  }

  /**
   * Rebases/merges uncommitted changes in `pausedChild` onto an updated `parent` worktree handle.
   *
   * Materializes the merged tree into `pausedChild` and updates `pausedChild.baseRef` to `parent.HEAD`.
   *
   * @param {GitWorktreeHandle} parent      - Updated parent worktree handle.
   * @param {GitWorktreeHandle} pausedChild - Suspended child worktree handle being resumed.
   *
   * @returns {Promise<ReconcileResult<GitSyncReceipt>>} Clean or conflicted synchronization result.
   */
  syncChild(parent: GitWorktreeHandle, pausedChild: GitWorktreeHandle): Promise<ReconcileResult<GitSyncReceipt>> {
    return gitWorktreeSyncChild(parent, pausedChild, this.effectiveExcludeGlobs);
  }

  /**
   * Synchronizes `rootHandle` onto the terminal commit of completed prerequisite runs.
   *
   * Updates `rootHandle.baseBranch` when prerequisite branches remain unmerged on `origin/main`.
   *
   * @param {GitWorktreeHandle}          rootHandle           - Task root worktree handle.
   * @param {readonly GitScopeReceipt[]} prerequisiteReceipts - Terminal scope receipts of completed prerequisites.
   *
   * @returns {Promise<ReconcileResult<GitSyncReceipt>>} Clean or conflicted synchronization result.
   */
  syncRoot(rootHandle: GitWorktreeHandle, prerequisiteReceipts: readonly GitScopeReceipt[]): Promise<ReconcileResult<GitSyncReceipt>> {
    return gitWorktreeSyncRoot(rootHandle, prerequisiteReceipts, this.effectiveExcludeGlobs);
  }

  /**
   * Returns a temporary write capability lease (`fs:match-globs`) for `handle.unresolvedConflictPaths`.
   *
   * Returns `undefined` when `handle.unresolvedConflictPaths` is empty.
   *
   * @param {GitWorktreeHandle} handle - Worktree handle containing unresolved conflict paths.
   *
   * @returns {LeaseDelta | undefined} Temporary conflict write lease delta, or `undefined` when clean.
   */
  getConflictLease(handle: GitWorktreeHandle): LeaseDelta | undefined {
    return buildConflictLeaseDelta(handle);
  }
}
