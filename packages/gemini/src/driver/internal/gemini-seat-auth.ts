/**
 * Resolved authentication headers and active seat metadata for a Google Gemini `generateContent` turn.
 *
 * Returned by `resolveGeminiSeatAuth()` and passed to `GeminiHttpTransport.sendGenerateContentRequest()`.
 */
export interface GeminiSeatAuth {
  /** Resolved identifier of the selected `GeminiAccountSeatNode`, if any. */
  readonly seatId: string | undefined;
  /** Authentication mechanism selected for the request (`'cli-oauth'`, `'api-key'`, or `'none'`). */
  readonly authSource: 'cli-oauth' | 'api-key' | 'none';
  /** Frozen HTTP request headers (`content-type` and optional `x-goog-api-key` or `authorization`). */
  readonly headers: Readonly<Record<string, string>>;
}
