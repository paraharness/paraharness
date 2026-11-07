/**
 * Resolved Anthropic authentication headers and active seat metadata for a single turn invocation.
 *
 * Produced by `resolveClaudeSeatAuth()` before dispatching an Anthropic `/v1/messages` request.
 */
export interface ClaudeSeatAuth {
  /** Active `ClaudeAccountSeatNode` identifier selected for the turn, when available. */
  readonly seatId: string | undefined;
  /** Authentication mechanism applied (`'cli-oauth'`, `'api-key'`, or `'none'`). */
  readonly authSource: 'cli-oauth' | 'api-key' | 'none';
  /** Outbound HTTP request headers including `anthropic-version` and credentials. */
  readonly headers: Readonly<Record<string, string>>;
}
