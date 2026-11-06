import {
  zodToJsonSchema,
  type CanonicalMessage,
  type CanonicalToolCall,
  type ModelTurnRequest,
  type ModelTurnResponse,
} from '@harness-dsl/core';
import {
  CLAUDE_THINKING_BUDGETS,
  DEFAULT_CLAUDE_MAX_TOKENS,
} from '../default-claude-http-transport.constants.js';
import {
  decodeFrameToAnthropicMessage,
  resolveAnthropicWireTools,
} from './claude-wire-helpers.js';

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
    for (const res of canonical.toolResults ?? []) {
      blocks.push(
        Object.freeze({
          type: 'tool_result',
          tool_use_id: res.callId,
          content: res.content,
          ...(res.isError ? { is_error: true } : {}),
        }),
      );
    }
    return Object.freeze({ role: 'user', content: Object.freeze(blocks) });
  }
  if (canonical.role === 'assistant') {
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
      blocks.push(Object.freeze({ type: 'tool_use', id: call.id, name: call.name, input: parsedInput }));
    }
    return Object.freeze({ role: 'assistant', content: Object.freeze(blocks) });
  }
  return Object.freeze({
    role: 'user',
    content: Object.freeze([Object.freeze({ type: 'text', text: canonical.visibleText })]),
  });
}

/**
 * Assembles an Anthropic `/v1/messages` request payload from a `ModelTurnRequest`.
 *
 * Pins `system` and `tools` from `CompiledWirePrefix`, preserves `tools` when `toolChoice === 'none'`,
 * and configures native `output_config.format` JSON-schema enforcement when `outputSchema` is present.
 *
 * @param {ModelTurnRequest} req - Turn invocation request parameters.
 *
 * @returns {Readonly<Record<string, unknown>>} Serialized Anthropic `/v1/messages` request body.
 */
export function buildAnthropicMessagesRequest(
  req: ModelTurnRequest,
): Readonly<Record<string, unknown>> {
  const messages: Readonly<Record<string, unknown>>[] = [];
  for (const frame of req.history) {
    messages.push(decodeFrameToAnthropicMessage(frame));
  }
  const tools = resolveAnthropicWireTools(req);
  const body: Record<string, unknown> = {
    model: req.modelId,
    max_tokens: DEFAULT_CLAUDE_MAX_TOKENS,
    messages: Object.freeze(messages),
  };
  if (req.wirePrefix !== undefined && req.wirePrefix.systemPromptText.length > 0) {
    body['system'] = req.wirePrefix.systemPromptText;
  }
  if (tools.length > 0) {
    body['tools'] = tools;
  }
  if (req.toolChoice !== undefined) {
    body['tool_choice'] = Object.freeze({ type: req.toolChoice });
  }
  if (req.effort !== undefined) {
    body['thinking'] = Object.freeze({
      type: 'enabled',
      budget_tokens: CLAUDE_THINKING_BUDGETS[req.effort],
    });
  }
  if (req.outputSchema !== undefined) {
    body['output_config'] = Object.freeze({
      format: Object.freeze({ type: 'json_schema', schema: zodToJsonSchema(req.outputSchema) }),
    });
  }
  return Object.freeze(body);
}

/**
 * Parses an Anthropic `/v1/messages` response payload into a `ModelTurnResponse`.
 *
 * Preserves exact `thinking` and `signature` blocks in `wireFrame`, extracts `tool_use` calls into
 * `canonical.toolCalls`, and validates `structuredOutput` when `canonical.toolCalls` is empty.
 *
 * @param {Readonly<Record<string, unknown>>} responseBody - Raw JSON object returned by `/v1/messages`.
 * @param {ModelTurnRequest}                  req          - Originating turn request with optional `outputSchema`.
 *
 * @returns {ModelTurnResponse} Parsed turn response with raw wire bytes, canonical message, and usage.
 */
export function parseAnthropicMessagesResponse(
  responseBody: Readonly<Record<string, unknown>>,
  req: ModelTurnRequest,
): ModelTurnResponse {
  const rawContent = Array.isArray(responseBody['content'])
    ? (responseBody['content'] as readonly Readonly<Record<string, unknown>>[])
    : [];
  const textParts: string[] = [];
  const toolCalls: CanonicalToolCall[] = [];
  for (const block of rawContent) {
    if (block['type'] === 'text' && typeof block['text'] === 'string') {
      textParts.push(block['text']);
    } else if (block['type'] === 'tool_use' && typeof block['id'] === 'string' && typeof block['name'] === 'string') {
      toolCalls.push(Object.freeze({ id: block['id'], name: block['name'], argsJson: JSON.stringify(block['input'] ?? {}) }));
    }
  }
  const visibleText = textParts.join('');
  const wireFrame = new TextEncoder().encode(JSON.stringify({ role: 'assistant', content: rawContent }));
  const structuredOutput =
    toolCalls.length === 0 && req.outputSchema !== undefined && visibleText.trim().length > 0
      ? req.outputSchema.parse(JSON.parse(visibleText))
      : undefined;
  const usageRaw = (responseBody['usage'] ?? {}) as Readonly<Record<string, unknown>>;
  const inputTokens = typeof usageRaw['input_tokens'] === 'number' ? usageRaw['input_tokens'] : 0;
  const cachedInputTokens = typeof usageRaw['cache_read_input_tokens'] === 'number' ? usageRaw['cache_read_input_tokens'] : 0;
  const outputTokens = typeof usageRaw['output_tokens'] === 'number' ? usageRaw['output_tokens'] : 0;
  const costUsd = typeof usageRaw['cost_usd'] === 'number' ? usageRaw['cost_usd'] : (inputTokens * 0.003 + outputTokens * 0.015) / 1_000;
  const canonical = Object.freeze<CanonicalMessage>({
    role: 'assistant',
    visibleText,
    toolCalls: toolCalls.length > 0 ? Object.freeze(toolCalls) : undefined,
    toolResults: undefined,
  });
  return Object.freeze<ModelTurnResponse>({
    wireFrame,
    canonical,
    structuredOutput,
    usage: Object.freeze({ inputTokens, cachedInputTokens, outputTokens, costUsd }),
  });
}
