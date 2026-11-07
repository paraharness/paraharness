/**
 * HTTP request descriptor passed to `OpenAiHttpTransport.sendResponsesRequest()`.
 *
 * Encapsulates the target OpenAI `/v1/responses` endpoint URL, authorization headers,
 * wire-formatted JSON request payload, resolved seat metadata, and optional abort signal.
 */
export interface OpenAiHttpRequest {
  /** Target OpenAI Responses API endpoint URL. */
  readonly url: string;
  /** HTTP request headers including bearer credentials. */
  readonly headers: Readonly<Record<string, string>>;
  /** Serialized OpenAI `/v1/responses` request payload object. */
  readonly body: Readonly<Record<string, unknown>>;
  /** Optional identifier of the active `OpenAiAccountSeatNode` selected for this turn. */
  readonly seatId?: string;
  /** Resolved authentication mechanism used for the request (`'cli-oauth'`, `'api-key'`, or `'none'`). */
  readonly authSource?: 'cli-oauth' | 'api-key' | 'none';
  /** Optional abort signal cancelling the in-flight HTTP request. */
  readonly signal?: AbortSignal;
  /** Optional custom `fetch` implementation passed to the underlying `openai` SDK client. */
  readonly fetch?: typeof globalThis.fetch;
}
