import {
  zodToJsonSchema,
  type CanonicalMessage,
  type ModelTurnRequest,
  type ModelTurnResponse,
} from '@paraharness/core';
import {
  CLAUDE_CODE_OAUTH_SYSTEM_PREAMBLE_TEXT,
  CLAUDE_THINKING_BUDGETS,
  DEFAULT_CLAUDE_MAX_TOKENS,
} from '../default-claude-http-transport.constants.js';
import { computeAnthropicTurnUsage } from './compute-anthropic-turn-usage.js';
import { decodeFrameToAnthropicMessage } from './decode-frame-to-anthropic-message.js';
import { extractAnthropicContentBlocks } from './extract-anthropic-content-blocks.js';
import { resolveAnthropicWireTools } from './resolve-anthropic-wire-tools.js';

/**
 * Options controlling wire-level formatting in `buildAnthropicMessagesRequest()`.
 */
export interface BuildAnthropicMessagesRequestOptions {
  /** Whether the active seat authenticates via Claude Code CLI OAuth (`'cli-oauth'`). */
  readonly isCliOAuth?: boolean;
}

/**
 * Builds the `system` field for a Claude Code CLI OAuth `/v1/messages` payload.
 *
 * Prepends the mandatory Claude Code preamble block as `system[0]` and appends
 * `systemPromptText` with `cache_control: { type: 'ephemeral' }` when non-empty.
 *
 * @param {string | undefined} systemPromptText - Optional system prompt text from `CompiledWirePrefix`.
 *
 * @returns {readonly Readonly<Record<string, unknown>>[]} Frozen array of Anthropic system text blocks.
 */
function buildCliOAuthSystemBlocks(
  systemPromptText: string | undefined,
): readonly Readonly<Record<string, unknown>>[] {
  const blocks: Readonly<Record<string, unknown>>[] = [
    Object.freeze({
      type: 'text',
      text: CLAUDE_CODE_OAUTH_SYSTEM_PREAMBLE_TEXT,
    }),
  ];
  if (systemPromptText !== undefined && systemPromptText.length > 0) {
    blocks.push(
      Object.freeze({
        type: 'text',
        text: systemPromptText,
        cache_control: Object.freeze({ type: 'ephemeral' }),
      }),
    );
  }
  return Object.freeze(blocks);
}

/**
 * Assembles an Anthropic `/v1/messages` request payload from a `ModelTurnRequest`.
 *
 * Pins `system` and `tools` from `CompiledWirePrefix`, prepends the mandatory Claude Code `system[0]`
 * preamble block when `options.isCliOAuth === true`, preserves `tools` when `toolChoice === 'none'`,
 * and configures native `output_config.format` JSON-schema enforcement when `outputSchema` is present.
 *
 * @param {ModelTurnRequest}                             req       - Turn invocation request parameters.
 * @param {BuildAnthropicMessagesRequestOptions | undefined} [options] - Optional CLI OAuth wire formatting options.
 *
 * @returns {Readonly<Record<string, unknown>>} Serialized Anthropic `/v1/messages` request body.
 */
export function buildAnthropicMessagesRequest(
  req: ModelTurnRequest,
  options?: BuildAnthropicMessagesRequestOptions,
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
  if (options?.isCliOAuth === true) {
    body['system'] = buildCliOAuthSystemBlocks(req.wirePrefix?.systemPromptText);
  } else if (req.wirePrefix !== undefined && req.wirePrefix.systemPromptText.length > 0) {
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
 *
 * @throws {Error} If `req.outputSchema` is present and the response JSON fails schema validation.
 */
export function parseAnthropicMessagesResponse(
  responseBody: Readonly<Record<string, unknown>>,
  req: ModelTurnRequest,
): ModelTurnResponse {
  const { rawContent, visibleText, toolCalls } = extractAnthropicContentBlocks(responseBody);
  const wireFrame = new TextEncoder().encode(
    JSON.stringify({ role: 'assistant', content: rawContent }),
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
    usage: computeAnthropicTurnUsage(responseBody, req.modelId),
  });
}
