import type { CanonicalMessage } from './canonical-message.js';

/**
 * Token usage and cost metrics returned by a single `ModelDriver.invokeTurn()` call.
 *
 * Tracks non-cached input tokens, prefix-cached input tokens, output/reasoning tokens, and USD cost.
 */
export interface ModelUsageMetrics {
  /** Number of non-cached input tokens billed for the turn. */
  readonly inputTokens: number;
  /** Number of prefix-cached input tokens read during the turn. */
  readonly cachedInputTokens: number;
  /** Number of output and reasoning tokens generated during the turn. */
  readonly outputTokens: number;
  /** Total monetary cost in USD for the turn. */
  readonly costUsd: number;
}

/**
 * Response returned by a single `ModelDriver.invokeTurn()` call.
 *
 * Pairs the raw UTF-8 vendor wire bytes with the canonical message projection, optional
 * parsed structured output, and token usage metrics.
 */
export interface ModelTurnResponse {
  /** Raw UTF-8 provider wire JSON bytes preserving vendor reasoning signatures. */
  readonly wireFrame: Uint8Array;
  /** Vendor-neutral canonical message projection of the assistant response. */
  readonly canonical: CanonicalMessage;
  /** Parsed structured output object (populated only when `canonical.toolCalls` is empty). */
  readonly structuredOutput?: unknown;
  /** Token usage and USD cost metrics for the turn. */
  readonly usage: ModelUsageMetrics;
}
