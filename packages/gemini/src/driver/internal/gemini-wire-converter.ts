import {
  zodToJsonSchema,
  type CanonicalMessage,
  type ModelTurnRequest,
  type ModelTurnResponse,
} from '@metaharness/core';
import { computeGeminiTurnUsage } from './compute-gemini-turn-usage.js';
import { decodeHistoryToAlternatingGeminiContents } from './decode-history-to-alternating-gemini-contents.js';
import { extractGeminiCandidateParts } from './extract-gemini-candidate-parts.js';
import { resolveGeminiFunctionDeclarations } from './resolve-gemini-function-declarations.js';

/**
 * Assembles a Google Gemini `generateContent` request body from a `ModelTurnRequest`.
 *
 * Maps `CompiledWirePrefix` to `systemInstruction` and `tools: [{ functionDeclarations }]`, enforces
 * strict `user` / `model` role alternation, and maps `outputSchema`, `effort`, and `toolChoice`.
 *
 * @param {ModelTurnRequest} req - Turn invocation request parameters.
 *
 * @returns {Readonly<Record<string, unknown>>} Serialized Gemini `generateContent` request body.
 */
export function buildGeminiGenerateContentRequest(
  req: ModelTurnRequest,
): Readonly<Record<string, unknown>> {
  const contents = decodeHistoryToAlternatingGeminiContents(req.history);
  const functionDeclarations = resolveGeminiFunctionDeclarations(req);
  const generationConfig: Record<string, unknown> = {};
  let hasGenerationConfig = false;
  if (req.outputSchema !== undefined) {
    generationConfig['responseMimeType'] = 'application/json';
    generationConfig['responseJsonSchema'] = zodToJsonSchema(req.outputSchema);
    hasGenerationConfig = true;
  }
  if (req.effort !== undefined) {
    generationConfig['thinkingConfig'] = Object.freeze({
      thinkingLevel: req.effort.toUpperCase(),
      includeThoughts: true,
    });
    hasGenerationConfig = true;
  }
  const body: Record<string, unknown> = { contents };
  const sysText = req.wirePrefix?.systemPromptText ?? '';
  if (sysText.length > 0) {
    body['systemInstruction'] = Object.freeze({
      parts: Object.freeze([Object.freeze({ text: sysText })]),
    });
  }
  if (functionDeclarations.length > 0) {
    body['tools'] = Object.freeze([Object.freeze({ functionDeclarations })]);
  }
  if (req.toolChoice !== undefined) {
    body['toolConfig'] = Object.freeze({
      functionCallingConfig: Object.freeze({
        mode: req.toolChoice === 'none' ? 'NONE' : 'AUTO',
      }),
    });
  }
  if (hasGenerationConfig) {
    body['generationConfig'] = Object.freeze(generationConfig);
  }
  return Object.freeze(body);
}

/**
 * Parses a Google Gemini `generateContent` JSON response into a `ModelTurnResponse`.
 *
 * Preserves `thought: true` and `thoughtSignature` fields on `role: 'model'` parts in `wireFrame`,
 * extracts `functionCall` parts into `canonical.toolCalls`, and validates `structuredOutput`.
 *
 * @param {Readonly<Record<string, unknown>>} responseBody - Raw JSON object returned by `generateContent`.
 * @param {ModelTurnRequest}                  req          - Originating turn request with optional `outputSchema`.
 *
 * @returns {ModelTurnResponse} Parsed turn response with raw wire bytes, canonical message, and usage.
 *
 * @throws {Error} If `req.outputSchema` is present and the response JSON fails schema validation.
 */
export function parseGeminiGenerateContentResponse(
  responseBody: Readonly<Record<string, unknown>>,
  req: ModelTurnRequest,
): ModelTurnResponse {
  const { rawParts, visibleText, toolCalls } = extractGeminiCandidateParts(responseBody);
  const wireFrame = new TextEncoder().encode(
    JSON.stringify({ role: 'model', parts: rawParts }),
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
    usage: computeGeminiTurnUsage(responseBody),
  });
}
