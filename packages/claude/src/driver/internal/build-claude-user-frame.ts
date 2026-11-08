import type { CanonicalMessage, WireFrameRecord } from '@metaharness/core';
import { projectCanonicalToAnthropicMessage } from './project-canonical-to-anthropic-message.js';

/**
 * Parameters for constructing an Anthropic `role: 'user'` `WireFrameRecord` via `buildClaudeUserFrame()`.
 *
 * Supplies the message lineage identifiers and user prompt text content.
 */
export interface BuildClaudeUserFrameParams {
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
 * Encodes both the Anthropic `{ role: 'user', content: [{ type: 'text', text }] }` wire JSON and
 * the canonical user message representation.
 *
 * @param {BuildClaudeUserFrameParams} params - Message ID, parent message ID, and user prompt text.
 *
 * @returns {WireFrameRecord} Frozen user `WireFrameRecord` for Anthropic `/v1/messages`.
 */
export function buildClaudeUserFrame(params: BuildClaudeUserFrameParams): WireFrameRecord {
  const canonical = Object.freeze<CanonicalMessage>({
    role: 'user',
    visibleText: params.text,
    toolCalls: undefined,
    toolResults: undefined,
  });
  return Object.freeze<WireFrameRecord>({
    messageId: params.messageId,
    parentMessageId: params.parentMessageId,
    vendorId: 'anthropic',
    rawWireFrame: new TextEncoder().encode(
      JSON.stringify(projectCanonicalToAnthropicMessage(canonical)),
    ),
    canonical,
    prefixDigest: 'fork-seed',
    compactedTombstones: undefined,
  });
}
