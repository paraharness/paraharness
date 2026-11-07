import type { CanonicalToolCall } from '@harness-dsl/core';

/**
 * Extracted candidate parts, visible text, and canonical tool calls from a Gemini `generateContent` payload.
 *
 * Returned by `extractGeminiCandidateParts()` and consumed by `parseGeminiGenerateContentResponse()`.
 */
export interface ExtractedGeminiCandidateParts {
  /** Raw `parts` array from the first candidate (preserving `thought` and `thoughtSignature`). */
  readonly rawParts: readonly Readonly<Record<string, unknown>>[];
  /** Concatenated visible text from non-thought `{ text }` parts. */
  readonly visibleText: string;
  /** Extracted canonical tool call descriptors from `{ functionCall }` parts. */
  readonly toolCalls: readonly CanonicalToolCall[];
}
