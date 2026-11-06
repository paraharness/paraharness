import type { z } from 'zod';
import type { CheckpointableScope } from './checkpointable-scope.js';
import type { LeaseDelta } from './lease-delta.js';
import type { ReconcileResult } from './reconcile-result.js';

/**
 * Tier-3 runtime driver contract for branchable isolation scopes (`capabilityTier: 'branchable'`).
 *
 * Extends `CheckpointableScope` with Copy-on-Write child forking (`forkChild`), crash-recovery
 * child reattachment (`reattachChild`), zero-pollution 3-way child commit (`commitChild`),
 * dirty-safe child rebase (`syncChild`), and stacked prerequisite root sync (`syncRoot`).
 *
 * @template THandle  Runtime scope handle type.
 * @template TReceipt Validated scope inspection receipt shape.
 * @template TSync    Validated scope synchronization receipt shape.
 */
export interface BranchableScope<
  THandle = unknown,
  TReceipt extends Record<string, unknown> = Record<string, unknown>,
  TSync extends Record<string, unknown> = Record<string, unknown>,
> extends CheckpointableScope<THandle, TReceipt> {
  /** Literal capability marker confirming child branching support. */
  readonly supportsBranching: true;
  /** Zod schema validating synchronization receipts returned by `syncChild()` and `syncRoot()`. */
  readonly syncSchema: z.ZodType<TSync, z.ZodTypeDef, unknown>;

  /**
   * Forks an isolated child scope handle cloned from `parent`.
   *
   * Preserves uncommitted edits from `parent` inside the newly provisioned Copy-on-Write child handle.
   *
   * @param {THandle} parent - Parent scope handle to clone from.
   * @param {string}  forkId - Unique identifier of the child fork or speculative branch.
   *
   * @returns {Promise<THandle>} Newly provisioned child scope handle.
   */
  forkChild(parent: THandle, forkId: string): Promise<THandle>;

  /**
   * Rebinds an existing child scope handle during process reboot crash recovery.
   *
   * Restores the child worktree or isolated branch state and applies `checkpoint` when needed.
   *
   * @param {THandle} parent       - Parent scope handle.
   * @param {string}  forkId       - Unique identifier of the child fork.
   * @param {string}  [checkpoint] - Optional persisted `childScopeCheckpoint` fallback.
   *
   * @returns {Promise<THandle>} Reattached child scope handle.
   */
  reattachChild(parent: THandle, forkId: string, checkpoint?: string): Promise<THandle>;

  /**
   * Reconciles `child` into `parent` via a zero-pollution 3-way merge.
   *
   * When `parent` has advanced and conflicts with `child`, leaves `parent` untouched,
   * materializes the conflict state inside `child`, and returns `status: 'conflict'`.
   *
   * @param {THandle} child  - Completed child scope handle.
   * @param {THandle} parent - Target parent scope handle.
   *
   * @returns {Promise<ReconcileResult<TReceipt>>} Clean or conflicted reconciliation result.
   */
  commitChild(child: THandle, parent: THandle): Promise<ReconcileResult<TReceipt>>;

  /**
   * Rebases/merges uncommitted changes in `pausedChild` onto an updated `parent` handle.
   *
   * Preserves dirty working-tree edits in `pausedChild` across the 3-way rebase onto `parent`.
   *
   * @param {THandle} parent      - Updated parent scope handle.
   * @param {THandle} pausedChild - Suspended child scope handle being resumed.
   *
   * @returns {Promise<ReconcileResult<TSync>>} Clean or conflicted synchronization result.
   */
  syncChild(parent: THandle, pausedChild: THandle): Promise<ReconcileResult<TSync>>;

  /**
   * Synchronizes `rootHandle` onto completed prerequisite run receipts.
   *
   * Rebases or merges the task root scope onto the terminal commits of its prerequisite runs upon wakeup.
   *
   * @param {THandle}             rootHandle           - Task root scope handle.
   * @param {readonly TReceipt[]} prerequisiteReceipts - Terminal scope receipts of completed prerequisites.
   *
   * @returns {Promise<ReconcileResult<TSync>>} Clean or conflicted synchronization result.
   */
  syncRoot(
    rootHandle: THandle,
    prerequisiteReceipts: readonly TReceipt[],
  ): Promise<ReconcileResult<TSync>>;

  /**
   * Returns an optional temporary capability lease unlocking conflicted resources on `handle`.
   *
   * Granted automatically when `commitChild`, `syncChild`, or `syncRoot` returns `status: 'conflict'`.
   *
   * @param {THandle} handle - Scope handle containing unresolved conflicts.
   *
   * @returns {LeaseDelta | undefined} Temporary conflict resolution lease, or `undefined` if none.
   */
  getConflictLease?(handle: THandle): LeaseDelta | undefined;
}
