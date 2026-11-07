import type { CanonicalMessage, WireFrameRecord } from '@harness-dsl/core';
import { projectCanonicalToOpenAiWire } from './project-canonical-to-openai-wire.js';

/**
 * Parameters for constructing an OpenAI `role: 'user'` `WireFrameRecord` via `buildOpenAiUserFrame()`.
 *
 * Supplies the message lineage identifiers and user prompt text content.
 */
export interface BuildOpenAiUserFrameParams {
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
 * Encodes both the OpenAI `{ items: [{ type: 'message', role: 'user', content }] }` wire JSON and
 * the canonical user message representation.
 *
 * @param {BuildOpenAiUserFrameParams} params - Message ID, parent message ID, and user prompt text.
 *
 * @returns {WireFrameRecord} Frozen user `WireFrameRecord` for OpenAI `/v1/responses`.
 */
export function buildOpenAiUserFrame(params: BuildOpenAiUserFrameParams): WireFrameRecord {
  const canonical = Object.freeze<CanonicalMessage>({
    role: 'user',
    visibleText: params.text,
    toolCalls: undefined,
    toolResults: undefined,
  });
  return Object.freeze<WireFrameRecord>({
    messageId: params.messageId,
    parentMessageId: params.parentMessageId,
    vendorId: 'openai',
    rawWireFrame: new TextEncoder().encode(
      JSON.stringify(projectCanonicalToOpenAiWire(canonical)),
    ),
    canonical,
    prefixDigest: 'fork-seed',
    compactedTombstones: undefined,
  });
}
