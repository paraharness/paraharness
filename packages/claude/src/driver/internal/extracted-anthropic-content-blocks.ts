import type { CanonicalToolCall } from '@paraharness/core';

/**
 * Extracted content blocks, visible text, and canonical tool calls from an Anthropic `/v1/messages` response.
 *
 * Returned by `extractAnthropicContentBlocks()` and consumed by `parseAnthropicMessagesResponse()`.
 */
export interface ExtractedAnthropicContentBlocks {
  /** Raw `content` array returned by `/v1/messages` (preserving `thinking` + `signature` blocks). */
  readonly rawContent: readonly Readonly<Record<string, unknown>>[];
  /** Concatenated visible text from `{ type: 'text' }` blocks. */
  readonly visibleText: string;
  /** Extracted canonical tool call descriptors from `{ type: 'tool_use' }` blocks. */
  readonly toolCalls: readonly CanonicalToolCall[];
}
