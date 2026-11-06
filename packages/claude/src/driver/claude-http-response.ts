/**
 * HTTP response descriptor returned by `ClaudeHttpTransport.sendMessagesRequest()`.
 *
 * Carries the HTTP status code, parsed JSON response payload from Anthropic `/v1/messages`,
 * and optional rate-limit cooldown reset timestamp when `status === 429`.
 */
export interface ClaudeHttpResponse {
  /** HTTP status code returned by the Anthropic `/v1/messages` endpoint. */
  readonly status: number;
  /** Parsed JSON response body returned by the Anthropic API. */
  readonly body: Readonly<Record<string, unknown>>;
  /** Optional epoch timestamp in milliseconds when an HTTP `429` rate limit resets. */
  readonly resetAtMs?: number;
}
