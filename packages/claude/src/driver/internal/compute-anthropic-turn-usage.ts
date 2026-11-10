import type { ModelTurnResponse } from '@paraharness/core';
import {
  CLAUDE_MODEL_PRICING_PER_THOUSAND_TOKENS,
  TOKENS_PER_THOUSAND,
} from '../default-claude-http-transport.constants.js';

/**
 * Resolves the per-1k-token USD pricing entry for a Claude model identifier.
 *
 * Matches `'opus'` (`$15/$75` per MTok) and `'haiku'` (`$1/$5` per MTok) substrings case-insensitively,
 * defaulting to `'sonnet'` (`$3/$15` per MTok).
 *
 * @param {string | undefined} modelId - Active Claude model identifier.
 *
 * @returns {Readonly<{ readonly inputUsd: number; readonly outputUsd: number }>} USD rates per `1,000` input and output tokens.
 */
function resolveClaudeModelPricing(
  modelId: string | undefined,
): Readonly<{ readonly inputUsd: number; readonly outputUsd: number }> {
  const normalized = modelId?.toLowerCase() ?? '';
  if (normalized.includes('opus')) {
    return CLAUDE_MODEL_PRICING_PER_THOUSAND_TOKENS.opus;
  }
  if (normalized.includes('haiku')) {
    return CLAUDE_MODEL_PRICING_PER_THOUSAND_TOKENS.haiku;
  }
  return CLAUDE_MODEL_PRICING_PER_THOUSAND_TOKENS.sonnet;
}

/**
 * Extracts token usage and USD cost metrics from an Anthropic `/v1/messages` response payload.
 *
 * Reads `input_tokens`, `cache_read_input_tokens`, `output_tokens`, and `cost_usd` from `responseBody.usage`,
 * computing model-aware fallback `costUsd` from `modelId` (`opus`, `sonnet`, or `haiku`) when `cost_usd` is absent.
 *
 * @param {Readonly<Record<string, unknown>>} responseBody - Parsed JSON object returned by `/v1/messages`.
 * @param {string | undefined}                [modelId]    - Optional requested model identifier for rate selection.
 *
 * @returns {ModelTurnResponse['usage']} Frozen token usage and cost summary.
 */
export function computeAnthropicTurnUsage(
  responseBody: Readonly<Record<string, unknown>>,
  modelId?: string,
): ModelTurnResponse['usage'] {
  const usageRaw = (responseBody['usage'] ?? {}) as Readonly<Record<string, unknown>>;
  const inputTokens = typeof usageRaw['input_tokens'] === 'number' ? usageRaw['input_tokens'] : 0;
  const cachedInputTokens =
    typeof usageRaw['cache_read_input_tokens'] === 'number'
      ? usageRaw['cache_read_input_tokens']
      : 0;
  const outputTokens =
    typeof usageRaw['output_tokens'] === 'number' ? usageRaw['output_tokens'] : 0;
  const effectiveModelId =
    modelId ?? (typeof responseBody['model'] === 'string' ? responseBody['model'] : undefined);
  const pricing = resolveClaudeModelPricing(effectiveModelId);
  const costUsd =
    typeof usageRaw['cost_usd'] === 'number'
      ? usageRaw['cost_usd']
      : (inputTokens * pricing.inputUsd + outputTokens * pricing.outputUsd) / TOKENS_PER_THOUSAND;
  return Object.freeze({
    inputTokens,
    cachedInputTokens,
    outputTokens,
    costUsd,
  });
}
