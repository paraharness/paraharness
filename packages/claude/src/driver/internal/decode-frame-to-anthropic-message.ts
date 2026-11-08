import type { WireFrameRecord } from '@paraharness/core';
import { projectCanonicalToAnthropicMessage } from './project-canonical-to-anthropic-message.js';

/**
 * Decodes a single `WireFrameRecord` into an Anthropic `/v1/messages` wire message object.
 *
 * Uses `rawWireFrame` directly when it already holds a valid Anthropic `{ role, content }` message
 * (preserving `thinking` blocks, `signature` fields, and `cache_control`), and otherwise projects
 * from `frame.canonical`.
 *
 * @param {WireFrameRecord} frame - Conversation history frame record.
 *
 * @returns {Readonly<Record<string, unknown>>} Anthropic wire message object.
 */
export function decodeFrameToAnthropicMessage(
  frame: WireFrameRecord,
): Readonly<Record<string, unknown>> {
  const text = new TextDecoder().decode(frame.rawWireFrame).trim();
  if (text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text) as Readonly<Record<string, unknown>>;
      if (
        (parsed['role'] === 'user' || parsed['role'] === 'assistant') &&
        Array.isArray(parsed['content'])
      ) {
        return parsed;
      }
    } catch {
      return projectCanonicalToAnthropicMessage(frame.canonical);
    }
  }
  return projectCanonicalToAnthropicMessage(frame.canonical);
}
