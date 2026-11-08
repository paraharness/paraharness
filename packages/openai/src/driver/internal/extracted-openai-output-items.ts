import type { CanonicalToolCall } from '@metaharness/core';

/**
 * Extracted output items, visible text, and canonical tool calls from an OpenAI `/v1/responses` payload.
 *
 * Returned by `extractOpenAiOutputItems()` and consumed by `parseOpenAiResponsesOutput()`.
 */
export interface ExtractedOpenAiOutputItems {
  /** Raw `output` item array returned by `/v1/responses` (preserving server IDs and `encrypted_content`). */
  readonly rawOutput: readonly Readonly<Record<string, unknown>>[];
  /** Concatenated visible text from `message` output items. */
  readonly visibleText: string;
  /** Extracted canonical tool call descriptors from `function_call` items. */
  readonly toolCalls: readonly CanonicalToolCall[];
}
