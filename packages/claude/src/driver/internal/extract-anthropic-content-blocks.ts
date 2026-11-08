import type { CanonicalToolCall } from '@paraharness/core';
import type { ExtractedAnthropicContentBlocks } from './extracted-anthropic-content-blocks.js';

/**
 * Extracts raw content blocks, visible text, and canonical tool calls from an Anthropic `/v1/messages` response body.
 *
 * Preserves `rawContent` (including `thinking` and `signature` fields) intact for `wireFrame` serialization.
 *
 * @param {Readonly<Record<string, unknown>>} responseBody - Raw JSON object returned by `/v1/messages`.
 *
 * @returns {ExtractedAnthropicContentBlocks} Frozen extracted content blocks, visible text, and tool calls.
 */
export function extractAnthropicContentBlocks(
  responseBody: Readonly<Record<string, unknown>>,
): ExtractedAnthropicContentBlocks {
  const rawContent = Array.isArray(responseBody['content'])
    ? (responseBody['content'] as readonly Readonly<Record<string, unknown>>[])
    : [];
  const textParts: string[] = [];
  const toolCalls: CanonicalToolCall[] = [];
  for (const block of rawContent) {
    if (block['type'] === 'text' && typeof block['text'] === 'string') {
      textParts.push(block['text']);
    } else if (
      block['type'] === 'tool_use' &&
      typeof block['id'] === 'string' &&
      typeof block['name'] === 'string'
    ) {
      toolCalls.push(
        Object.freeze<CanonicalToolCall>({
          id: block['id'],
          name: block['name'],
          argsJson: JSON.stringify(block['input'] ?? {}),
        }),
      );
    }
  }
  return Object.freeze<ExtractedAnthropicContentBlocks>({
    rawContent,
    visibleText: textParts.join(''),
    toolCalls: Object.freeze(toolCalls),
  });
}
