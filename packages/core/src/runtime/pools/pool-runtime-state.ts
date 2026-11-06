/**
 * Mutable per-candidate runtime telemetry and rate-limit state inside a `PoolRuntimeState`.
 *
 * Tracks HTTP `429` cooldown windows, invocation counts, last-used timestamps, and empirical
 * completion counts for `escalate-on-retry` model selection.
 */
export interface PoolCandidateRuntimeMetrics {
  /** Candidate identifier (`seat.id`, `model.modelId`, or `model.alias`). */
  readonly id: string;
  /** Optional epoch timestamp in milliseconds until which this candidate is rate-limited (`429`). */
  rateLimitedUntilMs: number | undefined;
  /** Total number of times this candidate has been selected. */
  usageCount: number;
  /** Optional epoch timestamp in milliseconds of the most recent selection. */
  lastUsedAtMs: number | undefined;
  /** Number of completed executions that succeeded on this candidate. */
  successCount: number;
  /** Total number of completed or failed execution samples recorded for this candidate. */
  sampleCount: number;
}

/**
 * Per-pool runtime state managed by `PoolManager` (`SPEC.md` §3.2).
 *
 * Stores candidate telemetry metrics, round-robin cursor position, and run-sticky seat affinity
 * mappings for a single `PoolNode`.
 */
export interface PoolRuntimeState {
  /** Unique identifier of the `PoolNode`. */
  readonly poolId: string;
  /** Mutable runtime metrics indexed by candidate identifier. */
  readonly metricsById: Map<string, PoolCandidateRuntimeMetrics>;
  /** Next candidate index to inspect under `'round-robin'` selection. */
  roundRobinCursor: number;
  /** Map of active `runId` to sticky candidate identifier (`seat.id`). */
  readonly stickySeatByRunId: Map<string, string>;
}
