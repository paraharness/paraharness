import type { WireFrameRecord } from '@metaharness/core';
import { projectCanonicalToOpenAiWire } from './project-canonical-to-openai-wire.js';

/**
 * Decodes a `WireFrameRecord` into its OpenAI wire envelope `{ seatId?, responseId?, previous_response_id?, items }`.
 *
 * Uses `rawWireFrame` directly when it encodes an OpenAI `{ items }` envelope and otherwise projects
 * from `frame.canonical`.
 *
 * @param {WireFrameRecord} frame - Conversation history frame record.
 *
 * @returns {Readonly<Record<string, unknown>>} Decoded OpenAI wire envelope.
 */
export function decodeFrameToOpenAiWire(
  frame: WireFrameRecord,
): Readonly<Record<string, unknown>> {
  const text = new TextDecoder().decode(frame.rawWireFrame).trim();
  if (text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text) as Readonly<Record<string, unknown>>;
      if (Array.isArray(parsed['items'])) {
        return parsed;
      }
    } catch {
      return projectCanonicalToOpenAiWire(frame.canonical);
    }
  }
  return projectCanonicalToOpenAiWire(frame.canonical);
}
