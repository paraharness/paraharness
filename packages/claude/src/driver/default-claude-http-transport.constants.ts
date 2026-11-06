import type { ClaudeHttpRequest } from './claude-http-request.js';
import type { ClaudeHttpResponse } from './claude-http-response.js';
import type { ClaudeHttpTransport } from './claude-http-transport.js';

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

/** Default `fetch`-backed HTTP transport implementation for Anthropic `/v1/messages`. */
export const defaultClaudeHttpTransport: ClaudeHttpTransport = Object.freeze<ClaudeHttpTransport>({
  async sendMessagesRequest(request: ClaudeHttpRequest): Promise<ClaudeHttpResponse> {
    request.signal?.throwIfAborted();
    const response = await fetch(request.url, {
      method: 'POST',
      headers: request.headers,
      body: JSON.stringify(request.body),
      signal: request.signal,
    });
    const rawText = await response.text();
    const parsedBody =
      rawText.trim().length > 0
        ? (JSON.parse(rawText) as Readonly<Record<string, unknown>>)
        : Object.freeze({});
    const retryAfterHeader = response.headers.get('retry-after');
    const resetAtMs =
      retryAfterHeader !== null && !Number.isNaN(Number(retryAfterHeader))
        ? Date.now() + Number(retryAfterHeader) * 1_000
        : undefined;
    return Object.freeze<ClaudeHttpResponse>({
      status: response.status,
      body: parsedBody,
      resetAtMs,
    });
  },
});
