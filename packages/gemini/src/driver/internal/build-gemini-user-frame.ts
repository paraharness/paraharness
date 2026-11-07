import type { CanonicalMessage, WireFrameRecord } from '@harness-dsl/core';
import { projectCanonicalToGeminiContent } from './project-canonical-to-gemini-content.js';

/**
 * Parameters for constructing a Gemini `role: 'user'` `WireFrameRecord` via `buildGeminiUserFrame()`.
 *
 * Supplies the message lineage identifiers and user prompt text content.
 */
export interface BuildGeminiUserFrameParams {
  /** Unique message frame identifier. */
  readonly messageId: string;
  /** Preceding message frame identifier, or `null` for Turn 0. */
  readonly parentMessageId: string | null;
  /** User prompt text content. */
  readonly text: string;
}

/**
 * Constructs a `role: 'user'` `WireFrameRecord` seeded with `params.text` for Turn-0 or fork-point context injection.
 *
 * Encodes both the Gemini `{ role: 'user', parts: [{ text }] }` wire JSON and the canonical user message.
 *
 * @param {BuildGeminiUserFrameParams} params - Message ID, parent message ID, and user prompt text.
 *
 * @returns {WireFrameRecord} Frozen user `WireFrameRecord` for Gemini `generateContent`.
 */
export function buildGeminiUserFrame(params: BuildGeminiUserFrameParams): WireFrameRecord {
  const canonical = Object.freeze<CanonicalMessage>({
    role: 'user',
    visibleText: params.text,
    toolCalls: undefined,
    toolResults: undefined,
  });
  return Object.freeze<WireFrameRecord>({
    messageId: params.messageId,
    parentMessageId: params.parentMessageId,
    vendorId: 'google',
    rawWireFrame: new TextEncoder().encode(
      JSON.stringify(projectCanonicalToGeminiContent(canonical)),
    ),
    canonical,
    prefixDigest: 'fork-seed',
    compactedTombstones: undefined,
  });
}
