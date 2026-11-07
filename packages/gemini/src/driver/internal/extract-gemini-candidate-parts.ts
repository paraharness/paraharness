import type { CanonicalToolCall } from '@harness-dsl/core';
import type { ExtractedGeminiCandidateParts } from './extracted-gemini-candidate-parts.js';

/**
 * Extracts raw candidate parts, visible text, and canonical tool calls from a Gemini `generateContent` body.
 *
 * Preserves `rawParts` (including `thought: true` and `thoughtSignature`) intact for `wireFrame` serialization.
 *
 * @param {Readonly<Record<string, unknown>>} responseBody - Raw JSON object returned by `generateContent`.
 *
 * @returns {ExtractedGeminiCandidateParts} Frozen extracted candidate parts, visible text, and tool calls.
 */
export function extractGeminiCandidateParts(
  responseBody: Readonly<Record<string, unknown>>,
): ExtractedGeminiCandidateParts {
  const candidates = Array.isArray(responseBody['candidates'])
    ? (responseBody['candidates'] as readonly Readonly<Record<string, unknown>>[])
    : [];
  const contentObj = (candidates[0]?.['content'] ?? {
    role: 'model',
    parts: [],
  }) as Readonly<Record<string, unknown>>;
  const rawParts = Array.isArray(contentObj['parts'])
    ? (contentObj['parts'] as readonly Readonly<Record<string, unknown>>[])
    : [];
  const textParts: string[] = [];
  const toolCalls: CanonicalToolCall[] = [];
  for (let idx = 0; idx < rawParts.length; idx += 1) {
    const part = rawParts[idx];
    if (part === undefined || part['thought'] === true) {
      continue;
    }
    if (typeof part['text'] === 'string') {
      textParts.push(part['text']);
    } else if (part['functionCall'] !== undefined && typeof part['functionCall'] === 'object') {
      const fnCall = part['functionCall'] as Readonly<Record<string, unknown>>;
      const callId =
        typeof fnCall['id'] === 'string' ? fnCall['id'] : `gemini-call-${String(idx + 1)}`;
      toolCalls.push(
        Object.freeze<CanonicalToolCall>({
          id: callId,
          name: String(fnCall['name'] ?? ''),
          argsJson: JSON.stringify(fnCall['args'] ?? {}),
        }),
      );
    }
  }
  return Object.freeze<ExtractedGeminiCandidateParts>({
    rawParts,
    visibleText: textParts.join(''),
    toolCalls: Object.freeze(toolCalls),
  });
}
