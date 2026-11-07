/**
 * Attempts to decode `rawWireFrame` bytes as a native Gemini `{ role: 'user' | 'model', parts }` content object.
 *
 * Returns `undefined` when `rawWireFrame` is empty, fails JSON parsing, or encodes a non-Gemini wire format
 * (such as Anthropic `{ role, content }` or OpenAI `{ items }`).
 *
 * @param {Uint8Array} rawWireFrame - Raw wire frame bytes from a `WireFrameRecord`.
 *
 * @returns {Readonly<Record<string, unknown>> | undefined} Decoded Gemini content object, or `undefined`.
 */
export function tryDecodeGeminiWireContent(
  rawWireFrame: Uint8Array,
): Readonly<Record<string, unknown>> | undefined {
  const rawText = new TextDecoder().decode(rawWireFrame).trim();
  if (!rawText.startsWith('{')) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(rawText) as Readonly<Record<string, unknown>>;
    if (
      (parsed['role'] === 'user' || parsed['role'] === 'model') &&
      Array.isArray(parsed['parts'])
    ) {
      return parsed;
    }
  } catch {
    return undefined;
  }
  return undefined;
}
