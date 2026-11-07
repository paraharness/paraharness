/**
 * HTTP response descriptor returned by `GeminiHttpTransport.sendGenerateContentRequest()`.
 *
 * Carries the HTTP status code, parsed JSON response payload or raw text body from Gemini
 * `generateContent`, response headers, and optional rate-limit cooldown reset timestamp when `status === 429`.
 */
export interface GeminiHttpResponse {
  /** HTTP status code returned by the Gemini `generateContent` endpoint. */
  readonly status: number;
  /** Parsed JSON response body returned by the Google Gemini API when available. */
  readonly body?: Readonly<Record<string, unknown>>;
  /** Optional raw HTTP response body text before JSON parsing. */
  readonly bodyText?: string;
  /** Optional HTTP response headers map (`retry-after`, etc.). */
  readonly headers?: Readonly<Record<string, string>>;
  /** Optional epoch timestamp in milliseconds when an HTTP `429` rate limit resets. */
  readonly resetAtMs?: number;
}
