import type { ModelUsageMetrics } from '@paraharness/core';

/**
 * Computes normalized `ModelUsageMetrics` from an OpenAI `/v1/responses` JSON payload.
 *
 * Extracts `input_tokens`, `input_tokens_details.cached_tokens`, `output_tokens`, and `cost_usd`
 * (falling back to standard token-rate estimation when `cost_usd` is absent).
 *
 * @param {Readonly<Record<string, unknown>>} responseBody - Raw JSON object returned by `/v1/responses`.
 *
 * @returns {ModelUsageMetrics} Frozen token and USD cost usage breakdown for the turn.
 */
export function computeOpenAiTurnUsage(
  responseBody: Readonly<Record<string, unknown>>,
): ModelUsageMetrics {
  const usageRaw = (responseBody['usage'] ?? {}) as Readonly<Record<string, unknown>>;
  const inputTokens =
    typeof usageRaw['input_tokens'] === 'number' ? usageRaw['input_tokens'] : 0;
  const details = (usageRaw['input_tokens_details'] ?? {}) as Readonly<Record<string, unknown>>;
  const cachedInputTokens =
    typeof details['cached_tokens'] === 'number' ? details['cached_tokens'] : 0;
  const outputTokens =
    typeof usageRaw['output_tokens'] === 'number' ? usageRaw['output_tokens'] : 0;
  const costUsd =
    typeof usageRaw['cost_usd'] === 'number'
      ? usageRaw['cost_usd']
      : (inputTokens * 0.0025 + outputTokens * 0.01) / 1_000;
  return Object.freeze<ModelUsageMetrics>({
    inputTokens,
    cachedInputTokens,
    outputTokens,
    costUsd,
  });
}
