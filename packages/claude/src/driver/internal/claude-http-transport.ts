import { APIError, Anthropic } from '@anthropic-ai/sdk';
import type { ClaudeHttpRequest } from '../claude-http-request.js';
import type { ClaudeHttpResponse } from '../claude-http-response.js';

/**
 * Parses an HTTP `retry-after` header value in seconds into an epoch timestamp in milliseconds.
 *
 * Returns `undefined` when the header is absent, empty, or not a finite number.
 *
 * @param {string | null | undefined} retryAfterHeader - Raw `retry-after` header string.
 *
 * @returns {number | undefined} Epoch timestamp in milliseconds when the rate-limit window resets.
 */
export function parseClaudeRetryAfterResetAtMs(
  retryAfterHeader: string | null | undefined,
): number | undefined {
  if (retryAfterHeader === null || retryAfterHeader === undefined || retryAfterHeader.trim().length === 0) {
    return undefined;
  }
  const seconds = Number(retryAfterHeader);
  return Number.isFinite(seconds) ? Date.now() + seconds * 1_000 : undefined;
}

/**
 * Derives the base URL passed to `new Anthropic({ baseURL })` from a `/v1/messages` endpoint URL.
 *
 * Strips a trailing `/v1/messages` or `/messages` path segment so `client.post('/v1/messages')` resolves cleanly.
 *
 * @param {string} endpointUrl - Full Anthropic `/v1/messages` endpoint URL.
 *
 * @returns {string} Normalized base URL for the `@anthropic-ai/sdk` client.
 */
export function resolveAnthropicSdkBaseUrl(endpointUrl: string): string {
  if (endpointUrl.endsWith('/v1/messages')) {
    return endpointUrl.slice(0, -'/v1/messages'.length);
  }
  if (endpointUrl.endsWith('/messages')) {
    return endpointUrl.slice(0, -'/messages'.length);
  }
  return endpointUrl;
}

/**
 * Wraps the target `fetch` function used by `@anthropic-ai/sdk` to preserve exact seat headers.
 *
 * Removes the placeholder `authorization` header injected by the SDK when `hasExplicitAuth` is `false`.
 *
 * @param {boolean}                 hasExplicitAuth - Whether the seat provided an explicit API key or OAuth token.
 * @param {typeof globalThis.fetch} baseFetch       - Underlying `fetch` implementation to invoke.
 *
 * @returns {typeof globalThis.fetch} Wrapped `fetch` function passed to `new Anthropic({ fetch })`.
 */
export function createAnthropicSdkFetch(
  hasExplicitAuth: boolean,
  baseFetch: typeof globalThis.fetch,
): typeof globalThis.fetch {
  return (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const mergedHeaders = new Headers(init?.headers);
    if (!hasExplicitAuth) {
      mergedHeaders.delete('authorization');
      mergedHeaders.delete('x-api-key');
    }
    return baseFetch(input, { ...init, headers: mergedHeaders });
  };
}

/**
 * Dispatches an Anthropic `/v1/messages` request through the official `@anthropic-ai/sdk` client.
 *
 * Uses `maxRetries: 0` so HTTP `429` and `5xx` statuses return immediately with `resetAtMs` and raw error text.
 *
 * @param {ClaudeHttpRequest} request - Outbound Anthropic `/v1/messages` request envelope.
 *
 * @returns {Promise<ClaudeHttpResponse>} HTTP status, parsed JSON body or error text, and `resetAtMs`.
 */
export async function sendClaudeMessagesViaSdk(request: ClaudeHttpRequest): Promise<ClaudeHttpResponse> {
  request.signal?.throwIfAborted();
  const rawAuth = request.headers['authorization'];
  const authToken = rawAuth?.startsWith('Bearer ') ? rawAuth.slice('Bearer '.length) : rawAuth;
  const apiKey = request.headers['x-api-key'];
  const hasAuth = (apiKey !== undefined && apiKey.length > 0) || (authToken !== undefined && authToken.length > 0);
  const client = new Anthropic({
    apiKey: apiKey ?? (authToken !== undefined ? null : 'anthropic-seat-unconfigured'),
    authToken: authToken ?? null,
    baseURL: resolveAnthropicSdkBaseUrl(request.url),
    maxRetries: 0,
    fetch: createAnthropicSdkFetch(hasAuth, request.fetch ?? globalThis.fetch),
  });
  try {
    const { data, response } = await client
      .post<Readonly<Record<string, unknown>>>('/v1/messages', {
        body: request.body, headers: request.headers, signal: request.signal,
      })
      .withResponse();
    return Object.freeze<ClaudeHttpResponse>({
      status: response.status, body: data, bodyText: undefined, headers: undefined,
      resetAtMs: parseClaudeRetryAfterResetAtMs(response.headers.get('retry-after')),
    });
  } catch (err: unknown) {
    if (err instanceof APIError) {
      const errBody = err.error !== undefined && err.error !== null && typeof err.error === 'object' ? (err.error as Readonly<Record<string, unknown>>) : Object.freeze({});
      return Object.freeze<ClaudeHttpResponse>({
        status: err.status ?? 500, body: errBody, bodyText: err.message, headers: undefined,
        resetAtMs: parseClaudeRetryAfterResetAtMs(err.headers?.get('retry-after')),
      });
    }
    throw err;
  }
}
