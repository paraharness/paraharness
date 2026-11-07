import type { ClaudeHttpResponse } from '../claude-http-response.js';
import { parseClaudeRetryAfterResetAtMs } from './parse-claude-retry-after-reset-at-ms.js';

/**
 * Parameters for validating an Anthropic HTTP response and extracting its JSON body.
 *
 * Used by `extractClaudeResponseBody()` to surface structured `429` rate-limit and non-2xx errors.
 */
export interface ExtractClaudeResponseBodyParams {
  /** HTTP response envelope returned by `ClaudeHttpTransport.sendMessagesRequest()`. */
  readonly response: ClaudeHttpResponse;
  /** Target Anthropic model identifier for diagnostic error messages. */
  readonly modelId: string;
  /** Optional active `ClaudeAccountSeatNode` identifier for diagnostic error messages. */
  readonly seatId: string | undefined;
}

/**
 * Validates the HTTP status on a `ClaudeHttpResponse` and returns the parsed JSON body.
 *
 * Checks HTTP status codes before invoking `JSON.parse(response.bodyText)` so non-JSON error
 * gateways (`502 Bad Gateway`) never throw `SyntaxError`, and attaches `{ status: 429, resetAtMs }`
 * on rate-limit responses.
 *
 * @param {ExtractClaudeResponseBodyParams} params - HTTP response envelope, model ID, and seat ID.
 *
 * @returns {Readonly<Record<string, unknown>>} Validated JSON response payload object.
 *
 * @throws {Error} With `{ status: 429, resetAtMs }` on HTTP `429` or `{ status }` on non-2xx responses.
 */
export function extractClaudeResponseBody(
  params: ExtractClaudeResponseBodyParams,
): Readonly<Record<string, unknown>> {
  const { response, modelId, seatId } = params;
  const resetAtMs =
    response.resetAtMs ??
    parseClaudeRetryAfterResetAtMs(
      response.headers?.['retry-after'] ?? response.headers?.['Retry-After'],
    );
  if (response.status === 429) {
    throw Object.assign(
      new Error(
        `Anthropic /v1/messages rate limit (429) on model '${modelId}' (seat '${seatId ?? 'default'}').`,
      ),
      { status: 429, resetAtMs: resetAtMs ?? Date.now() + 60_000 },
    );
  }
  if (response.status < 200 || response.status >= 300) {
    const trimmedText = response.bodyText?.trim() ?? '';
    const detail = trimmedText.length > 0 ? `: ${trimmedText}` : '';
    throw Object.assign(
      new Error(
        `Anthropic /v1/messages failed with HTTP ${String(response.status)} for model '${modelId}'${detail}.`,
      ),
      { status: response.status },
    );
  }
  if (response.body !== undefined) {
    return response.body;
  }
  const trimmedBodyText = response.bodyText?.trim() ?? '';
  if (trimmedBodyText.length > 0) {
    return JSON.parse(trimmedBodyText) as Readonly<Record<string, unknown>>;
  }
  return Object.freeze({});
}
