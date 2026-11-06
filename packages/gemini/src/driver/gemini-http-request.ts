/**
 * HTTP request descriptor passed to `GeminiHttpTransport.sendGenerateContentRequest()`.
 *
 * Encapsulates the target Google Gemini `/v1beta/models/{model}:generateContent` endpoint URL,
 * authentication headers, wire-formatted JSON request payload, resolved seat metadata, and optional abort signal.
 */
export interface GeminiHttpRequest {
  /** Target Google Gemini `generateContent` endpoint URL. */
  readonly url: string;
  /** HTTP request headers including `x-goog-api-key` or OAuth bearer credentials. */
  readonly headers: Readonly<Record<string, string>>;
  /** Serialized Gemini `generateContent` request payload object. */
  readonly body: Readonly<Record<string, unknown>>;
  /** Optional identifier of the active `GeminiAccountSeatNode` selected for this turn. */
  readonly seatId?: string;
  /** Resolved authentication mechanism used for the request (`'cli-oauth'`, `'api-key'`, or `'none'`). */
  readonly authSource?: 'cli-oauth' | 'api-key' | 'none';
  /** Optional abort signal cancelling the in-flight HTTP request. */
  readonly signal?: AbortSignal;
}
