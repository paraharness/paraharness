import type { CanonicalMessage, CanonicalToolResult } from '@metaharness/core';

/**
 * Projects a single `CanonicalToolResult` into an OpenAI `function_call_output` wire item.
 *
 * Sets `is_error: true` only when `toolResult.isError` is `true`.
 *
 * @param {CanonicalToolResult} toolResult - Canonical tool execution result entry.
 *
 * @returns {Readonly<Record<string, unknown>>} Frozen OpenAI `function_call_output` item.
 */
function buildOpenAiFunctionCallOutputItem(
  toolResult: CanonicalToolResult,
): Readonly<Record<string, unknown>> {
  if (toolResult.isError) {
    return Object.freeze({
      type: 'function_call_output',
      call_id: toolResult.callId,
      output: toolResult.content,
      is_error: true,
    });
  }
  return Object.freeze({
    type: 'function_call_output',
    call_id: toolResult.callId,
    output: toolResult.content,
  });
}

/**
 * Projects a vendor-neutral `CanonicalMessage` into an OpenAI Responses API wire frame object.
 *
 * Maps `tool` frames to `function_call_output` items, `assistant` frames to `message` and `function_call`
 * items, and `user` frames to `input_text` message items.
 *
 * @param {CanonicalMessage} canonical - Vendor-neutral canonical message to project.
 *
 * @returns {Readonly<Record<string, unknown>>} OpenAI wire envelope containing `items`.
 */
export function projectCanonicalToOpenAiWire(
  canonical: CanonicalMessage,
): Readonly<Record<string, unknown>> {
  const items: Readonly<Record<string, unknown>>[] = [];
  if (canonical.role === 'tool') {
    for (const toolResult of canonical.toolResults ?? []) {
      items.push(buildOpenAiFunctionCallOutputItem(toolResult));
    }
    return Object.freeze({ items: Object.freeze(items) });
  }
  if (canonical.role === 'assistant') {
    if (canonical.visibleText.length > 0 || (canonical.toolCalls?.length ?? 0) === 0) {
      const content = Object.freeze([
        Object.freeze({ type: 'output_text', text: canonical.visibleText }),
      ]);
      items.push(Object.freeze({ type: 'message', role: 'assistant', content }));
    }
    for (const call of canonical.toolCalls ?? []) {
      items.push(
        Object.freeze({
          type: 'function_call',
          call_id: call.id,
          name: call.name,
          arguments: call.argsJson,
        }),
      );
    }
    return Object.freeze({ items: Object.freeze(items) });
  }
  const content = Object.freeze([
    Object.freeze({ type: 'input_text', text: canonical.visibleText }),
  ]);
  items.push(Object.freeze({ type: 'message', role: 'user', content }));
  return Object.freeze({ items: Object.freeze(items) });
}
