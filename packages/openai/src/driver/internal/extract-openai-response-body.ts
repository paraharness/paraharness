import type { OpenAiHttpResponse } from '../openai-http-response.js';
import { parseOpenAiRetryAfterResetAtMs } from './parse-openai-retry-after-reset-at-ms.js';

/**
 * Parameters for validating an `OpenAiHttpResponse` and extracting its JSON body.
 *
 * Supplies the raw transport response along with `modelId` and `seatId` for error diagnostics.
 */
export interface ExtractOpenAiResponseBodyParams {
  /** Raw HTTP response envelope returned by `OpenAiHttpTransport.sendResponsesRequest()`. */
  readonly response: OpenAiHttpResponse;
  /** Target OpenAI model identifier for error messages. */
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
 * @param {ExtractOpenAiResponseBodyParams} params - Transport response, model ID, and seat ID.
 *
 * @returns {Readonly<Record<string, unknown>>} Validated JSON response body object.
 *
 * @throws {Error} On HTTP `429` rate limits (`{ status: 429, resetAtMs }`) or non-2xx HTTP statuses.
 */
export function extractOpenAiResponseBody(
  params: ExtractOpenAiResponseBodyParams,
): Readonly<Record<string, unknown>> {
  const { response, modelId, seatId } = params;
  const resetAtMs =
    response.resetAtMs ??
    parseOpenAiRetryAfterResetAtMs(
      response.headers?.['retry-after'] ?? response.headers?.['Retry-After'],
    );
  if (response.status === 429) {
    throw Object.assign(
      new Error(
        `OpenAI /v1/responses rate limit (429) on model '${modelId}' (seat '${seatId ?? 'default'}').`,
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
        `OpenAI /v1/responses failed with HTTP ${String(response.status)} for model '${modelId}'${detail}.`,
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
