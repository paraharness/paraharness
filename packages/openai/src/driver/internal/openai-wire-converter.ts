import {
  zodToJsonSchema,
  type CanonicalMessage,
  type ModelTurnRequest,
  type ModelTurnResponse,
} from '@harness-dsl/core';
import { computeOpenAiTurnUsage } from './compute-openai-turn-usage.js';
import { decodeHistoryToOpenAiResponsesInput } from './decode-history-to-openai-responses-input.js';
import { extractOpenAiOutputItems } from './extract-openai-output-items.js';
import { resolveOpenAiWireTools } from './resolve-openai-wire-tools.js';

/**
 * Assembles an OpenAI `/v1/responses` request payload from `req` and `activeSeatId`.
 *
 * Automatically strips `previous_response_id`, server item IDs (`rs_...`, `fc_...`, `msg_...`), and
 * `encrypted_content` when failing over across distinct OpenAI seats (`frameSeatId !== activeSeatId`).
 *
 * @param {ModelTurnRequest}   req            - Turn invocation request parameters.
 * @param {string | undefined} [activeSeatId] - Identifier of the active OpenAI account seat.
 *
 * @returns {Readonly<Record<string, unknown>>} Serialized OpenAI `/v1/responses` request body.
 */
export function buildOpenAiResponsesRequest(
  req: ModelTurnRequest,
  activeSeatId?: string,
): Readonly<Record<string, unknown>> {
  const { inputItems, previousResponseId } = decodeHistoryToOpenAiResponsesInput(
    req.history,
    activeSeatId,
  );
  const tools = resolveOpenAiWireTools(req);
  const body: Record<string, unknown> = {
    model: req.modelId,
    input: inputItems,
  };
  if (req.wirePrefix !== undefined && req.wirePrefix.systemPromptText.length > 0) {
    body['instructions'] = req.wirePrefix.systemPromptText;
  }
  if (previousResponseId !== undefined) {
    body['previous_response_id'] = previousResponseId;
  }
  if (tools.length > 0) {
    body['tools'] = tools;
  }
  if (req.toolChoice !== undefined) {
    body['tool_choice'] = req.toolChoice;
  }
  if (req.effort !== undefined) {
    body['reasoning'] = Object.freeze({ effort: req.effort, summary: 'auto' });
  }
  if (req.outputSchema !== undefined) {
    const format = Object.freeze({
      type: 'json_schema',
      name: 'structured_output',
      schema: zodToJsonSchema(req.outputSchema),
      strict: true,
    });
    body['text'] = Object.freeze({ format });
  }
  return Object.freeze(body);
}

/**
 * Parses an OpenAI `/v1/responses` JSON payload into a `ModelTurnResponse`.
 *
 * Preserves server item IDs (`rs_...`, `fc_...`, `msg_...`), `responseId`, `seatId`, and `encrypted_content`
 * in `wireFrame`, extracts `function_call` items, and validates `structuredOutput` when `toolCalls` is empty.
 *
 * @param {Readonly<Record<string, unknown>>} responseBody - Raw JSON object returned by `/v1/responses`.
 * @param {ModelTurnRequest}                  req          - Originating turn request with optional `outputSchema`.
 * @param {string | undefined}                [seatId]     - Optional active OpenAI seat identifier.
 *
 * @returns {ModelTurnResponse} Parsed turn response with raw wire bytes, canonical message, and usage.
 *
 * @throws {Error} If `req.outputSchema` is present and the response JSON fails schema validation.
 */
export function parseOpenAiResponsesOutput(
  responseBody: Readonly<Record<string, unknown>>,
  req: ModelTurnRequest,
  seatId?: string,
): ModelTurnResponse {
  const { rawOutput, visibleText, toolCalls } = extractOpenAiOutputItems(responseBody);
  const responseId =
    typeof responseBody['id'] === 'string' ? responseBody['id'] : undefined;
  const wireFrame = new TextEncoder().encode(
    JSON.stringify({ seatId, responseId, items: rawOutput }),
  );
  const shouldParseOutput =
    toolCalls.length === 0 && req.outputSchema !== undefined && visibleText.trim().length > 0;
  const structuredOutput = shouldParseOutput
    ? req.outputSchema?.parse(JSON.parse(visibleText))
    : undefined;
  const canonical = Object.freeze<CanonicalMessage>({
    role: 'assistant',
    visibleText,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    toolResults: undefined,
  });
  return Object.freeze<ModelTurnResponse>({
    wireFrame,
    canonical,
    structuredOutput,
    usage: computeOpenAiTurnUsage(responseBody),
  });
}
