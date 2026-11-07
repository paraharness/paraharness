/**
 * HTTP response descriptor returned by `ClaudeHttpTransport.sendMessagesRequest()`.
 *
 * Carries the HTTP status code, parsed JSON response payload or raw text body from Anthropic
 * `/v1/messages`, response headers, and optional rate-limit cooldown reset timestamp when `status === 429`.
 */
export interface ClaudeHttpResponse {
  /** HTTP status code returned by the Anthropic `/v1/messages` endpoint. */
  readonly status: number;
  /** Parsed JSON response body returned by the Anthropic API when available. */
  readonly body?: Readonly<Record<string, unknown>>;
  /** Optional raw HTTP response body text before JSON parsing. */
  readonly bodyText?: string;
  /** Optional HTTP response headers map (`retry-after`, etc.). */
  readonly headers?: Readonly<Record<string, string>>;
  /** Optional epoch timestamp in milliseconds when an HTTP `429` rate limit resets. */
  readonly resetAtMs?: number;
}
