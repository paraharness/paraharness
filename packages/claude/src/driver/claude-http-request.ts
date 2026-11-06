/**
 * HTTP request descriptor passed to `ClaudeHttpTransport.sendMessagesRequest()`.
 *
 * Encapsulates the target Anthropic `/v1/messages` endpoint URL, authentication headers,
 * wire-formatted JSON request payload, resolved seat metadata, and optional abort signal.
 */
export interface ClaudeHttpRequest {
  /** Target Anthropic Messages API endpoint URL. */
  readonly url: string;
  /** HTTP request headers including `anthropic-version` and OAuth bearer or `x-api-key` credentials. */
  readonly headers: Readonly<Record<string, string>>;
  /** Serialized Anthropic `/v1/messages` request payload object. */
  readonly body: Readonly<Record<string, unknown>>;
  /** Optional identifier of the active `ClaudeAccountSeatNode` selected for this turn. */
  readonly seatId?: string;
  /** Resolved authentication mechanism used for the request (`'cli-oauth'`, `'api-key'`, or `'none'`). */
  readonly authSource?: 'cli-oauth' | 'api-key' | 'none';
  /** Optional abort signal cancelling the in-flight HTTP request. */
  readonly signal?: AbortSignal;
}
