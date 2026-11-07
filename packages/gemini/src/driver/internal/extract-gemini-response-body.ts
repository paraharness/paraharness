import type { GeminiHttpResponse } from '../gemini-http-response.js';
import { parseGeminiRetryAfterResetAtMs } from './parse-gemini-retry-after-reset-at-ms.js';

/**
 * Parameters for validating a `GeminiHttpResponse` and extracting its JSON body.
 *
 * Supplies the raw transport response along with `modelId` and `seatId` for error diagnostics.
 */
export interface ExtractGeminiResponseBodyParams {
  /** Raw HTTP response envelope returned by `GeminiHttpTransport.sendGenerateContentRequest()`. */
  readonly response: GeminiHttpResponse;
  /** Target Gemini model identifier for error messages. */
  readonly modelId: string;
  /** Resolved seat identifier for rate-limit diagnostics. */
  readonly seatId: string | undefined;
}

/**
 * Validates HTTP status codes on `response` and extracts the parsed JSON response body.
 *
 * Checks HTTP `429` and non-2xx statuses before calling `JSON.parse(response.bodyText)` so
 * HTML or plain-text gateway errors never throw `SyntaxError`.
 *
 * @param {ExtractGeminiResponseBodyParams} params - Transport response, model ID, and seat ID.
 *
 * @returns {Readonly<Record<string, unknown>>} Validated JSON response body object.
 *
 * @throws {Error} On HTTP `429` rate limits (`{ status: 429, resetAtMs }`) or non-2xx HTTP statuses.
 */
export function extractGeminiResponseBody(
  params: ExtractGeminiResponseBodyParams,
): Readonly<Record<string, unknown>> {
  const { response, modelId, seatId } = params;
  const resetAtMs =
    response.resetAtMs ??
    parseGeminiRetryAfterResetAtMs(
      response.headers?.['retry-after'] ?? response.headers?.['Retry-After'],
    );
  if (response.status === 429) {
    throw Object.assign(
      new Error(
        `Gemini generateContent rate limit (429) on model '${modelId}' (seat '${seatId ?? 'default'}').`,
      ),
      { status: 429, resetAtMs: resetAtMs ?? Date.now() + 60_000 },
    );
  }
  if (response.status < 200 || response.status >= 300) {
    const detail =
      response.bodyText !== undefined && response.bodyText.trim().length > 0
        ? `: ${response.bodyText.trim()}`
        : '';
    throw Object.assign(
      new Error(
        `Gemini generateContent failed with HTTP ${String(response.status)} for model '${modelId}'${detail}.`,
      ),
      { status: response.status },
    );
  }
  if (response.body !== undefined) {
    return response.body;
  }
  if (response.bodyText !== undefined && response.bodyText.trim().length > 0) {
    return JSON.parse(response.bodyText) as Readonly<Record<string, unknown>>;
  }
  return Object.freeze({});
}
