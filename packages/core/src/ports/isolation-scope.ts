import type { z } from 'zod';

/**
 * Tier-1 base runtime driver contract for isolated execution scopes (`capabilityTier: 'scope'`).
 *
 * Manages root handle acquisition, crash-recovery reattachment, side-effect-free inspection,
 * and deterministic resource cleanup without requiring checkpointing or child branching.
 *
 * @template THandle  Runtime scope handle type.
 * @template TReceipt Validated scope inspection receipt shape.
 */
export interface IsolationScope<
  THandle = unknown,
  TReceipt extends Record<string, unknown> = Record<string, unknown>,
> {
  /** Unique identifier of the isolation scope driver. */
  readonly id: string;
  /** Zod schema validating receipts returned by `inspect()`. */
  readonly receiptSchema: z.ZodType<TReceipt>;

  /**
   * Provisions and initializes an isolated root scope handle for `runId`.
   *
   * Executes any configured scope setup commands and pins the initial base state for the run.
   *
   * @param {string} runId - Unique identifier of the flow run.
   *
   * @returns {Promise<THandle>} Newly acquired root scope handle.
   */
  acquireRoot(runId: string): Promise<THandle>;

  /**
   * Rebinds an existing root scope handle during process reboot crash recovery.
   *
   * Restores the handle from persistent disk or remote state and falls back to `checkpoint` when needed.
   *
   * @param {string} runId        - Unique identifier of the recovering flow run.
   * @param {string} [checkpoint] - Optional persisted `baseScopeCheckpoint` fallback.
   *
   * @returns {Promise<THandle>} Reattached root scope handle.
   */
  reattachRoot(runId: string, checkpoint?: string): Promise<THandle>;

  /**
   * Captures a side-effect-free inspection receipt (`TReceipt`) for `handle`.
   *
   * Validates the returned receipt against `receiptSchema` before exposing it to `.inputFrom()` or `.evaluate()`.
   *
   * @param {THandle} handle - Active scope handle to inspect.
   *
   * @returns {Promise<TReceipt>} Validated inspection receipt.
   */
  inspect(handle: THandle): Promise<TReceipt>;

  /**
   * Releases and cleans up an ephemeral root or child scope handle.
   *
   * Invoked inside `finally` blocks when a branch, tournament loser, or completed flow run terminates.
   *
   * @param {THandle} handle - Scope handle to release.
   *
   * @returns {Promise<void>} Resolves once all resources for `handle` are released.
   */
  release(handle: THandle): Promise<void>;
}
