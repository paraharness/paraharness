import type { CanonicalMessage, CanonicalToolResult } from '@paraharness/core';

/**
 * Projects a single `CanonicalToolResult` into an Anthropic `tool_result` content block.
 *
 * Sets `is_error: true` only when `toolResult.isError` is `true`.
 *
 * @param {CanonicalToolResult} toolResult - Canonical tool execution result entry.
 *
 * @returns {Readonly<Record<string, unknown>>} Frozen Anthropic `tool_result` block.
 */
function buildAnthropicToolResultBlock(
  toolResult: CanonicalToolResult,
): Readonly<Record<string, unknown>> {
  if (toolResult.isError) {
    return Object.freeze({
      type: 'tool_result',
      tool_use_id: toolResult.callId,
      content: toolResult.content,
      is_error: true,
    });
  }
  return Object.freeze({
    type: 'tool_result',
    tool_use_id: toolResult.callId,
    content: toolResult.content,
  });
}

/**
 * Projects an `assistant` `CanonicalMessage` into an Anthropic `{ role: 'assistant', content }` wire object.
 *
 * Omits `{ type: 'text' }` blocks whenever `canonical.visibleText === ''` and `canonical.toolCalls`
 * is non-empty so Anthropic never rejects empty text blocks.
 *
 * @param {CanonicalMessage} canonical - Assistant canonical message.
 *
 * @returns {Readonly<Record<string, unknown>>} Frozen Anthropic assistant message object.
 */
function projectAnthropicAssistantMessage(
  canonical: CanonicalMessage,
): Readonly<Record<string, unknown>> {
  const blocks: Readonly<Record<string, unknown>>[] = [];
  const hasToolCalls = (canonical.toolCalls?.length ?? 0) > 0;
  if (canonical.visibleText.length > 0 || !hasToolCalls) {
    blocks.push(Object.freeze({ type: 'text', text: canonical.visibleText }));
  }
  for (const call of canonical.toolCalls ?? []) {
    const parsedInput =
      call.argsJson.trim().length > 0
        ? (JSON.parse(call.argsJson) as Readonly<Record<string, unknown>>)
        : {};
    blocks.push(
      Object.freeze({
        type: 'tool_use',
        id: call.id,
        name: call.name,
        input: parsedInput,
      }),
    );
  }
  return Object.freeze({ role: 'assistant', content: Object.freeze(blocks) });
}

/**
 * Projects a vendor-neutral `CanonicalMessage` into an Anthropic `/v1/messages` wire message object.
 *
 * Omits `{ type: 'text' }` blocks on `assistant` messages whenever `canonical.visibleText === ''`
 * and `canonical.toolCalls` is non-empty so Anthropic never rejects empty text blocks.
 *
 * @param {CanonicalMessage} canonical - Vendor-neutral canonical message to project.
 *
 * @returns {Readonly<Record<string, unknown>>} Anthropic wire message with `role` and `content` array.
 */
export function projectCanonicalToAnthropicMessage(
  canonical: CanonicalMessage,
): Readonly<Record<string, unknown>> {
  if (canonical.role === 'tool') {
    const blocks: Readonly<Record<string, unknown>>[] = [];
    for (const toolResult of canonical.toolResults ?? []) {
      blocks.push(buildAnthropicToolResultBlock(toolResult));
    }
    return Object.freeze({ role: 'user', content: Object.freeze(blocks) });
  }
  if (canonical.role === 'assistant') {
    return projectAnthropicAssistantMessage(canonical);
  }
  return Object.freeze({
    role: 'user',
    content: Object.freeze([Object.freeze({ type: 'text', text: canonical.visibleText })]),
  });
}
