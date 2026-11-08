import type { ModelUsageMetrics } from '@metaharness/core';

/**
 * Computes normalized `ModelUsageMetrics` from a Gemini `generateContent` JSON payload.
 *
 * Extracts `promptTokenCount`, `cachedContentTokenCount`, `candidatesTokenCount`, and `costUsd`
 * (falling back to standard token-rate estimation when `costUsd` is absent).
 *
 * @param {Readonly<Record<string, unknown>>} responseBody - Raw JSON object returned by `generateContent`.
 *
 * @returns {ModelUsageMetrics} Frozen token and USD cost usage breakdown for the turn.
 */
export function computeGeminiTurnUsage(
  responseBody: Readonly<Record<string, unknown>>,
): ModelUsageMetrics {
  const usageRaw = (responseBody['usageMetadata'] ?? {}) as Readonly<Record<string, unknown>>;
  const inputTokens =
    typeof usageRaw['promptTokenCount'] === 'number' ? usageRaw['promptTokenCount'] : 0;
  const cachedInputTokens =
    typeof usageRaw['cachedContentTokenCount'] === 'number'
      ? usageRaw['cachedContentTokenCount']
      : 0;
  const outputTokens =
    typeof usageRaw['candidatesTokenCount'] === 'number' ? usageRaw['candidatesTokenCount'] : 0;
  const costUsd =
    typeof usageRaw['costUsd'] === 'number'
      ? usageRaw['costUsd']
      : (inputTokens * 0.00125 + outputTokens * 0.005) / 1_000;
  return Object.freeze<ModelUsageMetrics>({
    inputTokens,
    cachedInputTokens,
    outputTokens,
    costUsd,
  });
}
