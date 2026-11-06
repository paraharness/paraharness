/**
 * Runtime telemetry and rate-limit state for a single candidate item inside a capacity pool.
 *
 * Provided to custom `PoolSelectorFn` callbacks so selection strategies can inspect empirical
 * completion rates, usage counts, and rate-limit cooldown timestamps.
 *
 * @template TItem Pooled resource item type (such as `AccountSeatASTNode` or `ModelASTNode`).
 */
export interface PoolCandidateState<TItem = unknown> {
  /** Underlying AST node for the pooled candidate item. */
  readonly item: TItem;
  /** Zero-based declaration index of the candidate inside `PoolNode.items`. */
  readonly index: number;
  /** Logical identifier or alias of the candidate item. */
  readonly id: string;
  /** Epoch timestamp in milliseconds until which this candidate is rate-limited, if applicable. */
  readonly rateLimitedUntilMs?: number;
  /** Total number of acquisitions served by this candidate in the current runtime. */
  readonly usageCount: number;
  /** Epoch timestamp in milliseconds when this candidate was most recently acquired. */
  readonly lastUsedAtMs?: number;
  /** Cumulative number of successful completions recorded for this candidate. */
  readonly successCount: number;
  /** Cumulative number of total attempts recorded for this candidate. */
  readonly sampleCount: number;
  /** Ratio `successCount / sampleCount` in `[0, 1]` (or `1` when `sampleCount === 0`). */
  readonly empiricalSuccessRate: number;
}
