import type { CanonicalToolCall } from '@paraharness/core';
import type { ExtractedOpenAiOutputItems } from './extracted-openai-output-items.js';

/**
 * Appends string `text` segments from an OpenAI message item's `content` array into `textParts`.
 *
 * Skips non-text content parts while preserving message part ordering.
 *
 * @param {readonly Readonly<Record<string, unknown>>[]} content   - Message `content` part array.
 * @param {string[]}                                     textParts - Mutable accumulator for visible text strings.
 */
function collectOpenAiMessageText(
  content: readonly Readonly<Record<string, unknown>>[],
  textParts: string[],
): void {
  for (const part of content) {
    if (typeof part['text'] === 'string') {
      textParts.push(part['text']);
    }
  }
}

/**
 * Extracts raw output items, visible text, and canonical tool calls from an OpenAI `/v1/responses` body.
 *
 * Preserves `rawOutput` (including `rs_...`/`fc_...`/`msg_...` IDs and `encrypted_content`) for `wireFrame`.
 *
 * @param {Readonly<Record<string, unknown>>} responseBody - Raw JSON object returned by `/v1/responses`.
 *
 * @returns {ExtractedOpenAiOutputItems} Frozen extracted output items, visible text, and tool calls.
 */
export function extractOpenAiOutputItems(
  responseBody: Readonly<Record<string, unknown>>,
): ExtractedOpenAiOutputItems {
  const rawOutput = Array.isArray(responseBody['output'])
    ? (responseBody['output'] as readonly Readonly<Record<string, unknown>>[])
    : [];
  const textParts: string[] = [];
  const toolCalls: CanonicalToolCall[] = [];
  for (const outputItem of rawOutput) {
    if (outputItem['type'] === 'message' && Array.isArray(outputItem['content'])) {
      collectOpenAiMessageText(
        outputItem['content'] as readonly Readonly<Record<string, unknown>>[],
        textParts,
      );
    } else if (
      outputItem['type'] === 'function_call' &&
      typeof outputItem['name'] === 'string'
    ) {
      const callId =
        typeof outputItem['call_id'] === 'string'
          ? outputItem['call_id']
          : String(outputItem['id'] ?? '');
      const argsJson =
        typeof outputItem['arguments'] === 'string'
          ? outputItem['arguments']
          : JSON.stringify(outputItem['arguments'] ?? {});
      toolCalls.push(
        Object.freeze<CanonicalToolCall>({
          id: callId,
          name: outputItem['name'],
          argsJson,
        }),
      );
    }
  }
  return Object.freeze<ExtractedOpenAiOutputItems>({
    rawOutput,
    visibleText: textParts.join(''),
    toolCalls: Object.freeze(toolCalls),
  });
}
