import type { ModelTurnResponse } from '@metaharness/core';

/**
 * Extracts token usage and USD cost metrics from an Anthropic `/v1/messages` response payload.
 *
 * Reads `input_tokens`, `cache_read_input_tokens`, `output_tokens`, and `cost_usd` from `responseBody.usage`.
 *
 * @param {Readonly<Record<string, unknown>>} responseBody - Parsed JSON object returned by `/v1/messages`.
 *
 * @returns {ModelTurnResponse['usage']} Frozen token usage and cost summary.
 */
export function computeAnthropicTurnUsage(
  responseBody: Readonly<Record<string, unknown>>,
): ModelTurnResponse['usage'] {
  const usageRaw = (responseBody['usage'] ?? {}) as Readonly<Record<string, unknown>>;
  const inputTokens = typeof usageRaw['input_tokens'] === 'number' ? usageRaw['input_tokens'] : 0;
  const cachedInputTokens =
    typeof usageRaw['cache_read_input_tokens'] === 'number'
      ? usageRaw['cache_read_input_tokens']
      : 0;
  const outputTokens =
    typeof usageRaw['output_tokens'] === 'number' ? usageRaw['output_tokens'] : 0;
  const costUsd =
    typeof usageRaw['cost_usd'] === 'number'
      ? usageRaw['cost_usd']
      : (inputTokens * 0.003 + outputTokens * 0.015) / 1_000;
  return Object.freeze({
    inputTokens,
    cachedInputTokens,
    outputTokens,
    costUsd,
  });
}
