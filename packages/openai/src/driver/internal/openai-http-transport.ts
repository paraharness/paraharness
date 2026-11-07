import { APIError, OpenAI } from 'openai';
import type { OpenAiHttpRequest } from '../openai-http-request.js';
import type { OpenAiHttpResponse } from '../openai-http-response.js';

/**
 * Parses an HTTP `retry-after` header value in seconds into an epoch timestamp in milliseconds.
 *
 * Returns `undefined` when the header is absent, empty, or not a finite number.
 *
 * @param {string | null | undefined} retryAfterHeader - Raw `retry-after` header string.
 *
 * @returns {number | undefined} Epoch timestamp in milliseconds when the rate-limit window resets.
 */
export function parseOpenAiRetryAfterResetAtMs(
  retryAfterHeader: string | null | undefined,
): number | undefined {
  if (retryAfterHeader === null || retryAfterHeader === undefined || retryAfterHeader.trim().length === 0) {
    return undefined;
  }
  const seconds = Number(retryAfterHeader);
  return Number.isFinite(seconds) ? Date.now() + seconds * 1_000 : undefined;
}

/**
 * Derives the base URL passed to `new OpenAI({ baseURL })` from a `/v1/responses` endpoint URL.
 *
 * Strips a trailing `/responses` path segment so `client.post('/responses')` targets `/v1/responses`.
 *
 * @param {string} endpointUrl - Full OpenAI `/v1/responses` endpoint URL.
 *
 * @returns {string} Normalized base URL for the `openai` SDK client.
 */
export function resolveOpenAiSdkBaseUrl(endpointUrl: string): string {
  if (endpointUrl.endsWith('/responses')) {
    return endpointUrl.slice(0, -'/responses'.length);
  }
  return endpointUrl;
}

/**
 * Wraps the target `fetch` function used by the `openai` SDK to preserve exact seat headers.
 *
 * Removes the placeholder `authorization` header injected by the SDK when `hasExplicitAuth` is `false`.
 *
 * @param {boolean}                 hasExplicitAuth - Whether the seat provided an explicit bearer credential.
 * @param {typeof globalThis.fetch} baseFetch       - Underlying `fetch` implementation to invoke.
 *
 * @returns {typeof globalThis.fetch} Wrapped `fetch` function passed to `new OpenAI({ fetch })`.
 */
export function createOpenAiSdkFetch(
  hasExplicitAuth: boolean,
  baseFetch: typeof globalThis.fetch,
): typeof globalThis.fetch {
  return (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const mergedHeaders = new Headers(init?.headers);
    if (!hasExplicitAuth) {
      mergedHeaders.delete('authorization');
    }
    return baseFetch(input, { ...init, headers: mergedHeaders });
  };
}

/**
 * Dispatches an OpenAI `/v1/responses` request through the official `openai` SDK client.
 *
 * Uses `maxRetries: 0` so HTTP `429` and `5xx` statuses return immediately with `resetAtMs` and raw error text.
 *
 * @param {OpenAiHttpRequest} request - Outbound OpenAI `/v1/responses` request envelope.
 *
 * @returns {Promise<OpenAiHttpResponse>} HTTP status, parsed JSON body or error text, and `resetAtMs`.
 */
export async function sendOpenAiResponsesViaSdk(request: OpenAiHttpRequest): Promise<OpenAiHttpResponse> {
  request.signal?.throwIfAborted();
  const rawAuth = request.headers['authorization'];
  const bearerToken = rawAuth?.startsWith('Bearer ') ? rawAuth.slice('Bearer '.length) : rawAuth;
  const hasAuth = bearerToken !== undefined && bearerToken.length > 0;
  const client = new OpenAI({
    apiKey: hasAuth ? bearerToken : 'openai-seat-unconfigured',
    baseURL: resolveOpenAiSdkBaseUrl(request.url),
    maxRetries: 0,
    fetch: createOpenAiSdkFetch(hasAuth, request.fetch ?? globalThis.fetch),
  });
  try {
    const { data, response } = await client
      .post<Readonly<Record<string, unknown>>>('/responses', {
        body: request.body, headers: request.headers, signal: request.signal,
      })
      .withResponse();
    return Object.freeze<OpenAiHttpResponse>({
      status: response.status, body: data, bodyText: undefined, headers: undefined,
      resetAtMs: parseOpenAiRetryAfterResetAtMs(response.headers.get('retry-after')),
    });
  } catch (err: unknown) {
    if (err instanceof APIError) {
      const errBody = err.error !== undefined && err.error !== null && typeof err.error === 'object' ? (err.error as Readonly<Record<string, unknown>>) : Object.freeze({});
      return Object.freeze<OpenAiHttpResponse>({
        status: err.status ?? 500, body: errBody, bodyText: err.message, headers: undefined,
        resetAtMs: parseOpenAiRetryAfterResetAtMs(err.headers?.get('retry-after')),
      });
    }
    throw err;
  }
}
