/**
 * HTTP response descriptor returned by `OpenAiHttpTransport.sendResponsesRequest()`.
 *
 * Carries the HTTP status code, parsed JSON response payload from OpenAI `/v1/responses`,
 * and optional rate-limit cooldown reset timestamp when `status === 429`.
 */
export interface OpenAiHttpResponse {
  /** HTTP status code returned by the OpenAI `/v1/responses` endpoint. */
  readonly status: number;
  /** Parsed JSON response body returned by the OpenAI Responses API. */
  readonly body: Readonly<Record<string, unknown>>;
  /** Optional epoch timestamp in milliseconds when an HTTP `429` rate limit resets. */
  readonly resetAtMs?: number;
}
