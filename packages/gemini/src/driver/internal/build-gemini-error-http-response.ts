import { ApiError } from '@google/genai';
import type { GeminiHttpResponse } from '../gemini-http-response.js';
import type { GeminiSdkFetchCapture } from './gemini-sdk-fetch-capture.js';
import { parseGeminiRetryAfterResetAtMs } from './parse-gemini-retry-after-reset-at-ms.js';

/**
 * Parameters for constructing a normalized `GeminiHttpResponse` from a caught `@google/genai` error.
 *
 * Combines the caught exception and the HTTP status/header capture sink.
 */
export interface BuildGeminiErrorHttpResponseParams {
  /** Caught exception from `ai.models.generateContent()`. */
  readonly err: unknown;
  /** Captured HTTP status and `retry-after` header from the underlying `fetch` call. */
  readonly capture: GeminiSdkFetchCapture;
}

/**
 * Converts an `@google/genai` `ApiError` or failed HTTP status into a `GeminiHttpResponse` envelope.
 *
 * Preserves the HTTP status code, raw error message, and `retry-after` reset timestamp without JSON parsing crashes.
 *
 * @param {BuildGeminiErrorHttpResponseParams} params - Caught SDK exception and captured HTTP response metadata.
 *
 * @returns {GeminiHttpResponse} Normalized error response descriptor.
 */
export function buildGeminiErrorHttpResponse(
  params: BuildGeminiErrorHttpResponseParams,
): GeminiHttpResponse {
  const { err, capture } = params;
  const status = err instanceof ApiError ? err.status : (capture.status ?? 500);
  const bodyText = err instanceof Error ? err.message : String(err);
  return Object.freeze<GeminiHttpResponse>({
    status,
    body: Object.freeze({}),
    bodyText,
    headers: undefined,
    resetAtMs: parseGeminiRetryAfterResetAtMs(capture.retryAfter),
  });
}
