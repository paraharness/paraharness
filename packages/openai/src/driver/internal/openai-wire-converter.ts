import {
  zodToJsonSchema,
  type CanonicalMessage,
  type CanonicalToolCall,
  type ModelTurnRequest,
  type ModelTurnResponse,
} from '@harness-dsl/core';
import { OPENAI_SERVER_ITEM_ID_PATTERN } from '../default-openai-http-transport.constants.js';
import { decodeFrameToOpenAiWire, resolveOpenAiWireTools } from './openai-wire-helpers.js';

/**
 * Strips account-bound `previous_response_id`, server item IDs (`rs_...`, `fc_...`, `msg_...`), and `encrypted_content`.
 *
 * Preserves reasoning `summary` text and canonical message/tool items so transcripts replay cleanly
 * across distinct models (`substituteTombstones: true`) or across distinct OpenAI seats (`Seat A` to `Seat B`).
 *
 * @param {Readonly<Record<string, unknown>>} wireEnvelope - Decoded OpenAI wire envelope.
 *
 * @returns {Readonly<Record<string, unknown>>} Sanitized OpenAI wire envelope with account-bound state removed.
 */
export function stripOpenAiServerItemIdsAndEncryptedContent(
  wireEnvelope: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const rawItems = Array.isArray(wireEnvelope['items'])
    ? (wireEnvelope['items'] as readonly Readonly<Record<string, unknown>>[])
    : [];
  const sanitizedItems: Readonly<Record<string, unknown>>[] = [];
  for (const item of rawItems) {
    const cleaned: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(item)) {
      if (key === 'encrypted_content') {
        continue;
      }
      if (key === 'id' && typeof val === 'string' && OPENAI_SERVER_ITEM_ID_PATTERN.test(val)) {
        continue;
      }
      cleaned[key] = val;
    }
    sanitizedItems.push(Object.freeze(cleaned));
  }
  return Object.freeze({ items: Object.freeze(sanitizedItems) });
}

/**
 * Assembles an OpenAI `/v1/responses` request payload from `req` and `activeSeatId`.
 *
 * Automatically strips `previous_response_id`, server item IDs (`rs_...`, `fc_...`, `msg_...`), and
 * `encrypted_content` when failing over across distinct OpenAI seats (`frameSeatId !== activeSeatId`).
 *
 * @param {ModelTurnRequest}   req          - Turn invocation request parameters.
 * @param {string | undefined} activeSeatId - Identifier of the active OpenAI account seat.
 *
 * @returns {Readonly<Record<string, unknown>>} Serialized OpenAI `/v1/responses` request body.
 */
export function buildOpenAiResponsesRequest(
  req: ModelTurnRequest,
  activeSeatId?: string,
): Readonly<Record<string, unknown>> {
  const envelopes: Readonly<Record<string, unknown>>[] = [];
  let hasCrossSeatFailover = false;
  for (const frame of req.history) {
    const env = decodeFrameToOpenAiWire(frame);
    envelopes.push(env);
    if (typeof env['seatId'] === 'string' && activeSeatId !== undefined && env['seatId'] !== activeSeatId) {
      hasCrossSeatFailover = true;
    }
  }
  const inputItems: Readonly<Record<string, unknown>>[] = [];
  let previousResponseId: string | undefined;
  for (const env of envelopes) {
    const effective = hasCrossSeatFailover ? stripOpenAiServerItemIdsAndEncryptedContent(env) : env;
    const candidatePrev = !hasCrossSeatFailover ? (effective['previous_response_id'] ?? effective['responseId']) : undefined;
    if (typeof candidatePrev === 'string') {
      previousResponseId = candidatePrev;
    }
    for (const item of (Array.isArray(effective['items']) ? effective['items'] : []) as readonly Readonly<Record<string, unknown>>[]) {
      inputItems.push(item);
    }
  }
  const tools = resolveOpenAiWireTools(req);
  const body: Record<string, unknown> = { model: req.modelId, input: Object.freeze(inputItems) };
  if (req.wirePrefix !== undefined && req.wirePrefix.systemPromptText.length > 0) body['instructions'] = req.wirePrefix.systemPromptText;
  if (previousResponseId !== undefined) body['previous_response_id'] = previousResponseId;
  if (tools.length > 0) body['tools'] = tools;
  if (req.toolChoice !== undefined) body['tool_choice'] = req.toolChoice;
  if (req.effort !== undefined) body['reasoning'] = Object.freeze({ effort: req.effort, summary: 'auto' });
  if (req.outputSchema !== undefined) {
    const format = Object.freeze({ type: 'json_schema', name: 'structured_output', schema: zodToJsonSchema(req.outputSchema), strict: true });
    body['text'] = Object.freeze({ format });
  }
  return Object.freeze(body);
}

/**
 * Appends string `text` segments from an OpenAI message item's `content` array into `textParts`.
 *
 * Skips non-text content parts while preserving message part ordering.
 *
 * @param {readonly Readonly<Record<string, unknown>>[]} content   - Message `content` part array.
 * @param {string[]}                                     textParts - Mutable accumulator for visible text strings.
 */
function collectOpenAiMessageText(
  content: readonly Readonly<Record<string, unknown>>[],
  textParts: string[],
): void {
  for (const part of content) {
    if (typeof part['text'] === 'string') {
      textParts.push(part['text']);
    }
  }
}

/**
 * Parses an OpenAI `/v1/responses` JSON payload into a `ModelTurnResponse`.
 *
 * Preserves server item IDs (`rs_...`, `fc_...`, `msg_...`), `responseId`, `seatId`, and `encrypted_content`
 * in `wireFrame`, extracts `function_call` items, and validates `structuredOutput` when `toolCalls` is empty.
 *
 * @param {Readonly<Record<string, unknown>>} responseBody - Raw JSON object returned by `/v1/responses`.
 * @param {ModelTurnRequest}                  req          - Originating turn request with optional `outputSchema`.
 * @param {string | undefined}                seatId       - Optional active OpenAI seat identifier.
 *
 * @returns {ModelTurnResponse} Parsed turn response with raw wire bytes, canonical message, and usage.
 */
export function parseOpenAiResponsesOutput(
  responseBody: Readonly<Record<string, unknown>>,
  req: ModelTurnRequest,
  seatId?: string,
): ModelTurnResponse {
  const rawOutput = Array.isArray(responseBody['output']) ? (responseBody['output'] as readonly Readonly<Record<string, unknown>>[]) : [];
  const textParts: string[] = [];
  const toolCalls: CanonicalToolCall[] = [];
  for (const item of rawOutput) {
    if (item['type'] === 'message' && Array.isArray(item['content'])) {
      collectOpenAiMessageText(item['content'] as readonly Readonly<Record<string, unknown>>[], textParts);
    } else if (item['type'] === 'function_call' && typeof item['name'] === 'string') {
      const callId = typeof item['call_id'] === 'string' ? item['call_id'] : String(item['id'] ?? '');
      const argsJson = typeof item['arguments'] === 'string' ? item['arguments'] : JSON.stringify(item['arguments'] ?? {});
      toolCalls.push(Object.freeze({ id: callId, name: item['name'], argsJson }));
    }
  }
  const visibleText = textParts.join('');
  const responseId = typeof responseBody['id'] === 'string' ? responseBody['id'] : undefined;
  const wireFrame = new TextEncoder().encode(JSON.stringify({ seatId, responseId, items: rawOutput }));
  const structuredOutput =
    toolCalls.length === 0 && req.outputSchema !== undefined && visibleText.trim().length > 0
      ? req.outputSchema.parse(JSON.parse(visibleText))
      : undefined;
  const usageRaw = (responseBody['usage'] ?? {}) as Readonly<Record<string, unknown>>;
  const inputTokens = typeof usageRaw['input_tokens'] === 'number' ? usageRaw['input_tokens'] : 0;
  const details = (usageRaw['input_tokens_details'] ?? {}) as Readonly<Record<string, unknown>>;
  const cachedInputTokens = typeof details['cached_tokens'] === 'number' ? details['cached_tokens'] : 0;
  const outputTokens = typeof usageRaw['output_tokens'] === 'number' ? usageRaw['output_tokens'] : 0;
  const costUsd = typeof usageRaw['cost_usd'] === 'number' ? usageRaw['cost_usd'] : (inputTokens * 0.0025 + outputTokens * 0.01) / 1_000;
  const canonical = Object.freeze<CanonicalMessage>({ role: 'assistant', visibleText, toolCalls: toolCalls.length > 0 ? Object.freeze(toolCalls) : undefined, toolResults: undefined });
  return Object.freeze<ModelTurnResponse>({ wireFrame, canonical, structuredOutput, usage: Object.freeze({ inputTokens, cachedInputTokens, outputTokens, costUsd }) });
}
