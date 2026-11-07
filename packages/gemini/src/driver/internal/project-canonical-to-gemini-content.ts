import type { CanonicalMessage, CanonicalToolResult } from '@harness-dsl/core';

/**
 * Projects a single `CanonicalToolResult` into a Gemini `functionResponse` content part.
 *
 * Maps `toolResult.isError === true` to `response: { error: content }` and `false` to `response: { result: content }`.
 *
 * @param {CanonicalToolResult}                     toolResult       - Canonical tool execution result entry.
 * @param {ReadonlyMap<string, string> | undefined} toolNameByCallId - Optional lookup from `callId` to tool name.
 *
 * @returns {Readonly<Record<string, unknown>>} Frozen Gemini `functionResponse` part.
 */
function buildGeminiFunctionResponsePart(
  toolResult: CanonicalToolResult,
  toolNameByCallId: ReadonlyMap<string, string> | undefined,
): Readonly<Record<string, unknown>> {
  const name = toolNameByCallId?.get(toolResult.callId) ?? toolResult.callId;
  const responseObj = toolResult.isError
    ? Object.freeze({ error: toolResult.content })
    : Object.freeze({ result: toolResult.content });
  return Object.freeze({
    functionResponse: Object.freeze({
      id: toolResult.callId,
      name,
      response: responseObj,
    }),
  });
}

/**
 * Projects a vendor-neutral `CanonicalMessage` into a Gemini `generateContent` content turn (`{ role, parts }`).
 *
 * Maps `tool` results to `functionResponse` parts (`{ error: content }` when `isError: true`, `{ result: content }`
 * when `isError: false`), `assistant` tool calls to `functionCall` parts, and `user` text to `{ text }` parts.
 *
 * @param {CanonicalMessage}                        canonical          - Vendor-neutral canonical message.
 * @param {ReadonlyMap<string, string> | undefined} [toolNameByCallId] - Optional lookup from `callId` to tool name.
 *
 * @returns {Readonly<Record<string, unknown>>} Gemini `{ role: 'user' | 'model', parts }` content object.
 */
export function projectCanonicalToGeminiContent(
  canonical: CanonicalMessage,
  toolNameByCallId?: ReadonlyMap<string, string>,
): Readonly<Record<string, unknown>> {
  const parts: Readonly<Record<string, unknown>>[] = [];
  if (canonical.role === 'tool') {
    for (const toolResult of canonical.toolResults ?? []) {
      parts.push(buildGeminiFunctionResponsePart(toolResult, toolNameByCallId));
    }
    return Object.freeze({ role: 'user', parts: Object.freeze(parts) });
  }
  if (canonical.role === 'assistant') {
    if (canonical.visibleText.length > 0 || (canonical.toolCalls?.length ?? 0) === 0) {
      parts.push(Object.freeze({ text: canonical.visibleText }));
    }
    for (const call of canonical.toolCalls ?? []) {
      const args =
        call.argsJson.trim().length > 0
          ? (JSON.parse(call.argsJson) as Readonly<Record<string, unknown>>)
          : {};
      parts.push(
        Object.freeze({
          functionCall: Object.freeze({ id: call.id, name: call.name, args }),
        }),
      );
    }
    return Object.freeze({ role: 'model', parts: Object.freeze(parts) });
  }
  parts.push(Object.freeze({ text: canonical.visibleText }));
  return Object.freeze({ role: 'user', parts: Object.freeze(parts) });
}
