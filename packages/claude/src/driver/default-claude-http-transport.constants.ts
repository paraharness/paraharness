import type { ClaudeHttpRequest } from './claude-http-request.js';
import type { ClaudeHttpResponse } from './claude-http-response.js';
import type { ClaudeHttpTransport } from './claude-http-transport.js';
import { sendClaudeMessagesViaSdk } from './internal/send-claude-messages-via-sdk.js';

/** Default Anthropic Messages API HTTPS endpoint URL. */
export const ANTHROPIC_MESSAGES_ENDPOINT = 'https://api.anthropic.com/v1/messages';

/** Default Anthropic API version header value. */
export const ANTHROPIC_API_VERSION = '2023-06-01';

/** Default `max_tokens` ceiling sent on Anthropic `/v1/messages` requests. */
export const DEFAULT_CLAUDE_MAX_TOKENS = 16_384;

/** Extended thinking token budgets keyed by reasoning effort level (`'low' | 'medium' | 'high'`). */
export const CLAUDE_THINKING_BUDGETS: Readonly<Record<'low' | 'medium' | 'high', number>> =
  Object.freeze({
    low: 2_048,
    medium: 8_192,
    high: 16_384,
  });

/** Candidate credential filenames searched inside a Claude CLI `configDir`. */
export const CLAUDE_CREDENTIAL_FILENAMES: readonly string[] = Object.freeze([
  '.credentials.json',
  'credentials.json',
  'oauth.json',
  'auth.json',
]);

/** Default `@anthropic-ai/sdk`-backed HTTP transport implementation for Anthropic `/v1/messages`. */
export const defaultClaudeHttpTransport: ClaudeHttpTransport = Object.freeze<ClaudeHttpTransport>({
  /**
   * Dispatches a `/v1/messages` POST request via the official `@anthropic-ai/sdk` client.
   *
   * Forwards `request` directly to `sendClaudeMessagesViaSdk()`.
   *
   * @param {ClaudeHttpRequest} request - Wire-formatted Anthropic `/v1/messages` request.
   *
   * @returns {Promise<ClaudeHttpResponse>} HTTP status, parsed body, and optional `resetAtMs`.
   *
   * @throws {Error} If `request.signal` is aborted or a network transport exception occurs.
   */
  sendMessagesRequest(request: ClaudeHttpRequest): Promise<ClaudeHttpResponse> {
    return sendClaudeMessagesViaSdk(request);
  },
});
