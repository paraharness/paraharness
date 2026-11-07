/**
 * Resolved authentication headers and active seat metadata for an OpenAI `/v1/responses` turn.
 *
 * Returned by `resolveOpenAiSeatAuth()` and passed to `OpenAiHttpTransport.sendResponsesRequest()`.
 */
export interface OpenAiSeatAuth {
  /** Resolved identifier of the selected `OpenAiAccountSeatNode`, if any. */
  readonly seatId: string | undefined;
  /** Authentication mechanism selected for the request (`'cli-oauth'`, `'api-key'`, or `'none'`). */
  readonly authSource: 'cli-oauth' | 'api-key' | 'none';
  /** Frozen HTTP request headers (`content-type` and optional `authorization`). */
  readonly headers: Readonly<Record<string, string>>;
}
