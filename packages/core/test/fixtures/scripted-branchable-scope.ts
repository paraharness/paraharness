import { z } from 'zod';
import type { BranchableScope } from '../../src/ports/branchable-scope.js';
import type { LeaseDelta } from '../../src/ports/lease-delta.js';
import type { ReconcileResult } from '../../src/ports/reconcile-result.types.js';
import type { ToolEffect } from '../../src/ports/tool-effect.js';
import { commitScriptedChild, syncScriptedChild, syncScriptedRoot } from './internal/reconcile-scripted-scope.js';

/**
 * Deterministic `BranchableScope` test fixture supporting checkpoints, `diffEffects`, child branching, and scripted conflicts (`SPEC.md` §3.5 & §3.7.2).
 *
 * Tracks live handles, serialized checkpoints, reattached handles, and configurable conflict outcomes for `commitChild`, `syncChild`, and `syncRoot`.
 */
export class ScriptedBranchableScope implements BranchableScope<string, Record<string, unknown>, Record<string, unknown>> {
  /** Unique scope driver identifier. */
  readonly id = 'scripted-branchable-scope';
  /** Literal marker confirming checkpoint support. */
  readonly supportsCheckpoints = true as const;
  /** Literal marker confirming branching support. */
  readonly supportsBranching = true as const;
  /** Zod schema validating inspection receipts. */
  readonly receiptSchema = z.record(z.unknown());
  /** Zod schema validating synchronization receipts. */
  readonly syncSchema = z.record(z.unknown());
  /** Mutable state map per scope handle. */
  readonly handleState = new Map<string, Record<string, unknown>>();
  /** Saved checkpoints keyed by checkpoint token. */
  readonly checkpoints = new Map<string, Record<string, unknown>>();
  /** Set of currently live (unreleased) scope handles. */
  readonly liveHandles = new Set<string>();
  /** Recorded `restoreCheckpoint` calls `(handle, checkpoint)`. */
  readonly restoredCheckpoints: Array<{ readonly handle: string; readonly checkpoint: string }> = [];
  /** Recorded `reattachRoot` and `reattachChild` calls. */
  readonly reattachedHandles: string[] = [];
  /** Scripted `diffEffects` queue or callback. */
  scriptedDiffEffects: readonly ToolEffect[] = [];
  /** Number of remaining `commitChild` calls that should return `status: 'conflict'`. */
  commitConflictRemainingCount = 0;
  /** Number of remaining `syncChild` calls that should return `status: 'conflict'`. */
  syncChildConflictRemainingCount = 0;
  /** Number of remaining `syncRoot` calls that should return `status: 'conflict'`. */
  syncRootConflictRemainingCount = 0;
  /** Optional conflict lease returned by `getConflictLease()`. */
  conflictLease: LeaseDelta | undefined = Object.freeze<LeaseDelta>({ type: 'harness:lease-delta', id: 'conflict-resolution-lease', grantedMatchers: Object.freeze([]) });
  /** Monotonic checkpoint counter. */
  private ckptSeq = 0;

  /**
   * Acquires a root scope handle for `runId`.
   *
   * Initializes `handleState` and registers the handle in `liveHandles`.
   *
   * @param {string} runId - Flow run identifier.
   *
   * @returns {Promise<string>} Root scope handle string.
   */
  async acquireRoot(runId: string): Promise<string> {
    const handle = `root:${runId}`;
    this.handleState.set(handle, { handle, headSha: `sha:${runId}:0` });
    this.liveHandles.add(handle);
    return handle;
  }
  /**
   * Reattaches an existing root scope handle during crash recovery.
   *
   * Records the handle in `reattachedHandles` and `liveHandles`.
   *
   * @param {string} runId        - Recovering flow run identifier.
   * @param {string} [checkpoint] - Optional base scope checkpoint.
   *
   * @returns {Promise<string>} Reattached root scope handle.
   */
  async reattachRoot(runId: string, checkpoint?: string): Promise<string> {
    const handle = `root:${runId}`;
    this.reattachedHandles.push(handle);
    this.liveHandles.add(handle);
    if (!this.handleState.has(handle)) {
      this.handleState.set(handle, { handle, checkpoint });
    }
    return handle;
  }
  /**
   * Inspects the current state receipt for `handle`.
   *
   * Returns a shallow copy of the handle's state record.
   *
   * @param {string} handle - Active scope handle.
   *
   * @returns {Promise<Record<string, unknown>>} Inspection receipt.
   */
  async inspect(handle: string): Promise<Record<string, unknown>> {
    return { ...(this.handleState.get(handle) ?? { handle }) };
  }
  /**
   * Releases `handle` and removes it from `liveHandles`.
   *
   * Used to verify worktree lifecycle guarantees in tournaments and forks.
   *
   * @param {string} handle - Scope handle to release.
   *
   * @returns {Promise<void>} Resolves once removed from `liveHandles`.
   */
  async release(handle: string): Promise<void> {
    this.liveHandles.delete(handle);
  }
  /**
   * Serializes the current state of `handle` into a checkpoint token.
   *
   * Stores a snapshot in `checkpoints`.
   *
   * @param {string} handle - Scope handle to snapshot.
   *
   * @returns {Promise<string>} Checkpoint token string.
   */
  async serializeCheckpoint(handle: string): Promise<string> {
    const token = `ckpt:${handle}:${String(++this.ckptSeq)}`;
    this.checkpoints.set(token, { ...(this.handleState.get(handle) ?? { handle }) });
    return token;
  }
  /**
   * Restores `handle` to the state captured by `checkpoint`.
   *
   * Records `{ handle, checkpoint }` in `restoredCheckpoints`.
   *
   * @param {string} handle     - Scope handle to roll back.
   * @param {string} checkpoint - Checkpoint token to restore.
   *
   * @returns {Promise<void>} Resolves once restored.
   */
  async restoreCheckpoint(handle: string, checkpoint: string): Promise<void> {
    this.restoredCheckpoints.push(Object.freeze({ handle, checkpoint }));
    const saved = this.checkpoints.get(checkpoint);
    if (saved !== undefined) {
      this.handleState.set(handle, { ...saved });
    }
  }
  /**
   * Returns `scriptedDiffEffects` for post-flight subprocess guard verification.
   *
   * Allows tests to script arbitrary synthesized `ToolEffect` lists.
   *
   * @param {string} _fromCheckpoint - Pre-tool checkpoint token.
   * @param {string} _handle         - Scope handle after execution.
   *
   * @returns {Promise<readonly ToolEffect[]>} Synthesized tool effects.
   */
  async diffEffects(_fromCheckpoint: string, _handle: string): Promise<readonly ToolEffect[]> {
    return this.scriptedDiffEffects;
  }
  /**
   * Forks an isolated child scope handle from `parent`.
   *
   * Registers the child handle in `liveHandles` and copies `parent`'s state.
   *
   * @param {string} parent - Parent scope handle.
   * @param {string} forkId - Child fork identifier.
   *
   * @returns {Promise<string>} Child scope handle.
   */
  async forkChild(parent: string, forkId: string): Promise<string> {
    const childHandle = `${parent}/child:${forkId}`;
    this.handleState.set(childHandle, { ...(this.handleState.get(parent) ?? {}), handle: childHandle });
    this.liveHandles.add(childHandle);
    return childHandle;
  }
  /**
   * Reattaches a child scope handle during crash recovery.
   *
   * Records the child handle in `reattachedHandles` and `liveHandles`.
   *
   * @param {string} parent        - Parent scope handle.
   * @param {string} forkId        - Child fork identifier.
   * @param {string} [_checkpoint] - Optional child scope checkpoint.
   *
   * @returns {Promise<string>} Reattached child scope handle.
   */
  async reattachChild(parent: string, forkId: string, _checkpoint?: string): Promise<string> {
    const childHandle = `${parent}/child:${forkId}`;
    this.reattachedHandles.push(childHandle);
    this.liveHandles.add(childHandle);
    return childHandle;
  }
  /**
   * Reconciles `child` into `parent`, returning a conflict when `commitConflictRemainingCount > 0`.
   *
   * Decrements `commitConflictRemainingCount` on each conflicted attempt.
   *
   * @param {string} child  - Completed child scope handle.
   * @param {string} parent - Target parent scope handle.
   *
   * @returns {Promise<ReconcileResult<Record<string, unknown>>>} Clean or conflicted reconciliation result.
   */
  async commitChild(child: string, parent: string): Promise<ReconcileResult<Record<string, unknown>>> {
    return commitScriptedChild(this, child, parent);
  }
  /**
   * Synchronizes `pausedChild` onto `parent`, returning a conflict when `syncChildConflictRemainingCount > 0`.
   *
   * Used during `resumeFork` to verify dirty-safe child rebase and conflict lease elevation.
   *
   * @param {string} parent      - Updated parent scope handle.
   * @param {string} pausedChild - Suspended child scope handle.
   *
   * @returns {Promise<ReconcileResult<Record<string, unknown>>>} Clean or conflicted sync result.
   */
  async syncChild(parent: string, pausedChild: string): Promise<ReconcileResult<Record<string, unknown>>> {
    return syncScriptedChild(this, parent, pausedChild);
  }
  /**
   * Synchronizes `rootHandle` onto completed prerequisite receipts.
   *
   * Returns a conflict when `syncRootConflictRemainingCount > 0`.
   *
   * @param {string}                             rootHandle           - Task root scope handle.
   * @param {readonly Record<string, unknown>[]} prerequisiteReceipts - Prerequisite terminal receipts.
   *
   * @returns {Promise<ReconcileResult<Record<string, unknown>>>} Clean or conflicted sync result.
   */
  async syncRoot(rootHandle: string, prerequisiteReceipts: readonly Record<string, unknown>[]): Promise<ReconcileResult<Record<string, unknown>>> {
    return syncScriptedRoot(this, rootHandle, prerequisiteReceipts);
  }
  /**
   * Returns the configured temporary `conflictLease` for `handle`.
   *
   * Invoked when `commitChild`, `syncChild`, or `syncRoot` returns `status: 'conflict'`.
   *
   * @param {string} _handle - Conflicted scope handle.
   *
   * @returns {LeaseDelta | undefined} Configured conflict lease.
   */
  getConflictLease(_handle: string): LeaseDelta | undefined {
    return this.conflictLease;
  }
}
