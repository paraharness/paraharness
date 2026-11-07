/**
 * Mutable response metadata sink populated by `createGeminiSdkFetch()` during a single SDK turn.
 *
 * Captures the raw HTTP status code and `retry-after` header before `@google/genai` parses the body.
 */
export interface GeminiSdkFetchCapture {
  /** HTTP status code observed on the underlying `fetch` response. */
  status: number | undefined;
  /** Raw `retry-after` header value observed on the underlying `fetch` response. */
  retryAfter: string | null;
}
