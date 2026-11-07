import { APIError, Anthropic } from '@anthropic-ai/sdk';
import type { ClaudeHttpRequest } from '../claude-http-request.js';
import type { ClaudeHttpResponse } from '../claude-http-response.js';
import { createAnthropicSdkFetch } from './create-anthropic-sdk-fetch.js';
import { parseClaudeRetryAfterResetAtMs } from './parse-claude-retry-after-reset-at-ms.js';
import { resolveAnthropicSdkBaseUrl } from './resolve-anthropic-sdk-base-url.js';

/**
 * Converts an `@anthropic-ai/sdk` `APIError` exception into a structured `ClaudeHttpResponse`.
 *
 * Preserves the HTTP status code, parsed error object when available, raw error message text,
 * and parsed `retry-after` reset timestamp.
 *
 * @param {APIError} err - Caught `@anthropic-ai/sdk` API error instance.
 *
 * @returns {ClaudeHttpResponse} Normalized HTTP response record for `ClaudeModelDriver`.
 */
function buildClaudeSdkApiErrorResponse(err: APIError): ClaudeHttpResponse {
  const errBody =
    err.error !== undefined && err.error !== null && typeof err.error === 'object'
      ? (err.error as Readonly<Record<string, unknown>>)
      : Object.freeze({});
  return Object.freeze<ClaudeHttpResponse>({
    status: err.status ?? 500,
    body: errBody,
    bodyText: err.message,
    headers: undefined,
    resetAtMs: parseClaudeRetryAfterResetAtMs(err.headers?.get('retry-after')),
  });
}

/**
 * Resolves the `apiKey` option passed to `new Anthropic()` from `apiKey` and `authToken`.
 *
 * Returns `apiKey` when present, `null` when OAuth `authToken` is active, and a placeholder string
 * when neither credential is provided (subsequently stripped by `createAnthropicSdkFetch`).
 *
 * @param {string | undefined} apiKey    - Explicit `x-api-key` header value, if present.
 * @param {string | undefined} authToken - Explicit OAuth bearer token, if present.
 *
 * @returns {string | null} Value for the `Anthropic` constructor `apiKey` option.
 */
function resolveAnthropicClientApiKeyOption(
  apiKey: string | undefined,
  authToken: string | undefined,
): string | null {
  if (apiKey !== undefined) {
    return apiKey;
  }
  if (authToken !== undefined) {
    return null;
  }
  return 'anthropic-seat-unconfigured';
}

/**
 * Dispatches an Anthropic `/v1/messages` request through the official `@anthropic-ai/sdk` client.
 *
 * Uses `maxRetries: 0` so HTTP `429` and `5xx` statuses return immediately with `resetAtMs` and raw error text.
 *
 * @param {ClaudeHttpRequest} request - Outbound Anthropic `/v1/messages` request envelope.
 *
 * @returns {Promise<ClaudeHttpResponse>} HTTP status, parsed JSON body or error text, and `resetAtMs`.
 *
 * @throws {Error} If `request.signal` is aborted or a network transport exception occurs.
 */
export async function sendClaudeMessagesViaSdk(
  request: ClaudeHttpRequest,
): Promise<ClaudeHttpResponse> {
  request.signal?.throwIfAborted();
  const rawAuth = request.headers['authorization'];
  const authToken = rawAuth?.startsWith('Bearer ') ? rawAuth.slice('Bearer '.length) : rawAuth;
  const apiKey = request.headers['x-api-key'];
  const hasExplicitAuth =
    (apiKey !== undefined && apiKey.length > 0) ||
    (authToken !== undefined && authToken.length > 0);
  const client = new Anthropic({
    apiKey: resolveAnthropicClientApiKeyOption(apiKey, authToken),
    authToken: authToken ?? null,
    baseURL: resolveAnthropicSdkBaseUrl(request.url),
    maxRetries: 0,
    fetch: createAnthropicSdkFetch({
      hasExplicitAuth,
      baseFetch: request.fetch ?? globalThis.fetch,
    }),
  });
  try {
    const sdkResponse = await client
      .post<Readonly<Record<string, unknown>>>('/v1/messages', {
        body: request.body,
        headers: request.headers,
        signal: request.signal,
      })
      .withResponse();
    return Object.freeze<ClaudeHttpResponse>({
      status: sdkResponse.response.status,
      body: sdkResponse.data,
      bodyText: undefined,
      headers: undefined,
      resetAtMs: parseClaudeRetryAfterResetAtMs(
        sdkResponse.response.headers.get('retry-after'),
      ),
    });
  } catch (err: unknown) {
    if (err instanceof APIError) {
      return buildClaudeSdkApiErrorResponse(err);
    }
    throw err;
  }
}
