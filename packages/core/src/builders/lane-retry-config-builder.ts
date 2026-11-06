import type { LaneRetryConfig } from '../ast/lane-node.js';

/**
 * Fluent sub-builder for step retry and exponential backoff (`lane.retry($ => ...)`).
 *
 * Configures the maximum attempt count per step, exponential backoff base interval in
 * milliseconds, and terminal failure state label.
 */
export interface LaneRetryConfigBuilder {
  /**
   * Sets the maximum number of execution attempts per step before failing the run.
   *
   * Defaults to `1` when not explicitly overridden.
   *
   * @param {number} count - Positive integer retry limit.
   *
   * @returns {LaneRetryConfigBuilder} New immutable retry builder.
   */
  tries(count: number): LaneRetryConfigBuilder;

  /**
   * Sets the base delay in milliseconds for exponential retry backoff.
   *
   * Defaults to `1000` milliseconds when not explicitly overridden.
   *
   * @param {number} baseMs - Non-negative base backoff in milliseconds.
   *
   * @returns {LaneRetryConfigBuilder} New immutable retry builder.
   */
  exponential(baseMs: number): LaneRetryConfigBuilder;

  /**
   * Sets the terminal state recorded when all retry attempts are exhausted.
   *
   * Defaults to `'failed'` when not explicitly overridden.
   *
   * @param {string} failState - Terminal failure state label (e.g. `'exhausted'`).
   *
   * @returns {LaneRetryConfigBuilder} New immutable retry builder.
   */
  orFail(failState: string): LaneRetryConfigBuilder;

  /**
   * Compiles the retry configuration into a frozen `LaneRetryConfig`.
   *
   * Returns an immutable `LaneRetryConfig` record for attachment to `LaneNode`.
   *
   * @returns {LaneRetryConfig} Deeply frozen lane retry configuration.
   */
  toAST(): LaneRetryConfig;
}

export type { LaneRetryConfigBuilder as LaneRetryBuilder };
