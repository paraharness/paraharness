import {
  zodToJsonSchema,
  type CanonicalMessage,
  type CanonicalToolCall,
  type ModelTurnRequest,
  type ModelTurnResponse,
} from '@harness-dsl/core';
import {
  decodeHistoryToAlternatingGeminiContents,
  resolveGeminiFunctionDeclarations,
} from './gemini-wire-helpers.js';

/**
 * Strips model-specific `thought: true` parts and cryptographic `thoughtSignature` fields from a Gemini content object.
 *
 * Used during cross-model forks and escalations (`substituteTombstones === true`) where Gemini thinking
 * signatures do not transfer across distinct model weights.
 *
 * @param {Readonly<Record<string, unknown>>} contentObj - Gemini `{ role, parts }` content object.
 *
 * @returns {Readonly<Record<string, unknown>>} Sanitized Gemini content object with thoughts and signatures removed.
 */
export function stripGeminiThoughtPartsAndSignatures(
  contentObj: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const rawParts = Array.isArray(contentObj['parts'])
    ? (contentObj['parts'] as readonly Readonly<Record<string, unknown>>[])
    : [];
  const sanitizedParts: Readonly<Record<string, unknown>>[] = [];
  for (const part of rawParts) {
    if (part['thought'] === true) {
      continue;
    }
    const cleaned: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(part)) {
      if (key === 'thoughtSignature') {
        continue;
      }
      cleaned[key] = val;
    }
    sanitizedParts.push(Object.freeze(cleaned));
  }
  return Object.freeze({
    role: contentObj['role'] ?? 'model',
    parts: Object.freeze(sanitizedParts),
  });
}

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
  if (req.outputSchema !== undefined) {
    generationConfig['responseMimeType'] = 'application/json';
    generationConfig['responseJsonSchema'] = zodToJsonSchema(req.outputSchema);
  }
  if (req.effort !== undefined) {
    generationConfig['thinkingConfig'] = Object.freeze({ thinkingLevel: req.effort.toUpperCase(), includeThoughts: true });
  }
  const sysText = req.wirePrefix?.systemPromptText ?? '';
  const systemInstruction = sysText.length > 0 ? Object.freeze({ parts: Object.freeze([Object.freeze({ text: sysText })]) }) : undefined;
  const toolConfig =
    req.toolChoice !== undefined
      ? Object.freeze({ functionCallingConfig: Object.freeze({ mode: req.toolChoice === 'none' ? 'NONE' : 'AUTO' }) })
      : undefined;
  return Object.freeze({
    contents,
    ...(systemInstruction !== undefined ? { systemInstruction } : {}),
    ...(functionDeclarations.length > 0 ? { tools: Object.freeze([Object.freeze({ functionDeclarations })]) } : {}),
    ...(toolConfig !== undefined ? { toolConfig } : {}),
    ...(Object.keys(generationConfig).length > 0 ? { generationConfig: Object.freeze(generationConfig) } : {}),
  });
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
 */
export function parseGeminiGenerateContentResponse(
  responseBody: Readonly<Record<string, unknown>>,
  req: ModelTurnRequest,
): ModelTurnResponse {
  const candidates = Array.isArray(responseBody['candidates']) ? (responseBody['candidates'] as readonly Readonly<Record<string, unknown>>[]) : [];
  const contentObj = (candidates[0]?.['content'] ?? { role: 'model', parts: [] }) as Readonly<Record<string, unknown>>;
  const rawParts = Array.isArray(contentObj['parts']) ? (contentObj['parts'] as readonly Readonly<Record<string, unknown>>[]) : [];
  const textParts: string[] = [];
  const toolCalls: CanonicalToolCall[] = [];
  for (let idx = 0; idx < rawParts.length; idx += 1) {
    const part = rawParts[idx];
    if (part === undefined || part['thought'] === true) {
      continue;
    }
    if (typeof part['text'] === 'string') {
      textParts.push(part['text']);
    } else if (part['functionCall'] !== undefined && typeof part['functionCall'] === 'object') {
      const fc = part['functionCall'] as Readonly<Record<string, unknown>>;
      const callId = typeof fc['id'] === 'string' ? fc['id'] : `gemini-call-${String(idx + 1)}`;
      toolCalls.push(Object.freeze({ id: callId, name: String(fc['name'] ?? ''), argsJson: JSON.stringify(fc['args'] ?? {}) }));
    }
  }
  const visibleText = textParts.join('');
  const wireFrame = new TextEncoder().encode(JSON.stringify({ role: 'model', parts: rawParts }));
  const structuredOutput =
    toolCalls.length === 0 && req.outputSchema !== undefined && visibleText.trim().length > 0
      ? req.outputSchema.parse(JSON.parse(visibleText))
      : undefined;
  const usageRaw = (responseBody['usageMetadata'] ?? {}) as Readonly<Record<string, unknown>>;
  const inputTokens = typeof usageRaw['promptTokenCount'] === 'number' ? usageRaw['promptTokenCount'] : 0;
  const cachedInputTokens = typeof usageRaw['cachedContentTokenCount'] === 'number' ? usageRaw['cachedContentTokenCount'] : 0;
  const outputTokens = typeof usageRaw['candidatesTokenCount'] === 'number' ? usageRaw['candidatesTokenCount'] : 0;
  const costUsd = typeof usageRaw['costUsd'] === 'number' ? usageRaw['costUsd'] : (inputTokens * 0.00125 + outputTokens * 0.005) / 1_000;
  const canonical = Object.freeze<CanonicalMessage>({ role: 'assistant', visibleText, toolCalls: toolCalls.length > 0 ? Object.freeze(toolCalls) : undefined, toolResults: undefined });
  return Object.freeze<ModelTurnResponse>({ wireFrame, canonical, structuredOutput, usage: Object.freeze({ inputTokens, cachedInputTokens, outputTokens, costUsd }) });
}
