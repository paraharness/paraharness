import type { IsolationScope } from './isolation-scope.js';
import type { ToolEffect } from './tool-effect.js';

/**
 * Tier-2 runtime driver contract for checkpointable isolation scopes (`capabilityTier: 'checkpointable' | 'branchable'`).
 *
 * Extends `IsolationScope` with uncommitted state snapshotting (`serializeCheckpoint`),
 * deterministic rollback (`restoreCheckpoint`), and post-flight effect diffing (`diffEffects`).
 *
 * @template THandle  Runtime scope handle type.
 * @template TReceipt Validated scope inspection receipt shape.
 */
export interface CheckpointableScope<
  THandle = unknown,
  TReceipt extends Record<string, unknown> = Record<string, unknown>,
> extends IsolationScope<THandle, TReceipt> {
  /** Literal capability marker confirming checkpoint support. */
  readonly supportsCheckpoints: true;

  /**
   * Captures the uncommitted state of `handle` into a serializable checkpoint token.
   *
   * Used before post-flight-guarded subprocess tools and prior to child fork or step suspension.
   *
   * @param {THandle} handle - Active scope handle to snapshot.
   *
   * @returns {Promise<string>} Serialized checkpoint identifier or payload.
   */
  serializeCheckpoint(handle: THandle): Promise<string>;

  /**
   * Restores `handle` to the exact state captured by `checkpoint`.
   *
   * Discards any uncommitted mutations made since `checkpoint` was serialized without losing prior turns.
   *
   * @param {THandle} handle     - Active scope handle to roll back.
   * @param {string}  checkpoint - Previously serialized checkpoint token.
   *
   * @returns {Promise<void>} Resolves once `handle` matches `checkpoint`.
   */
  restoreCheckpoint(handle: THandle, checkpoint: string): Promise<void>;

  /**
   * Synthesizes `ToolEffect` descriptors by deterministically diffing `handle` against `fromCheckpoint`.
   *
   * Enables post-flight policy guard and quota tripwire verification for arbitrary subprocess tools.
   *
   * @param {string}  fromCheckpoint - Pre-tool checkpoint token captured before execution.
   * @param {THandle} handle         - Scope handle after tool execution.
   *
   * @returns {Promise<readonly ToolEffect[]>} Synthesized tool effects for policy guard and tripwire evaluation.
   */
  diffEffects(fromCheckpoint: string, handle: THandle): Promise<readonly ToolEffect[]>;
}
