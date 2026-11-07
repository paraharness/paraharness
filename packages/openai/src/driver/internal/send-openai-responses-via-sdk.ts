import { APIError, OpenAI } from 'openai';
import type { OpenAiHttpRequest } from '../openai-http-request.js';
import type { OpenAiHttpResponse } from '../openai-http-response.js';
import { createOpenAiSdkFetch } from './create-openai-sdk-fetch.js';
import { parseOpenAiRetryAfterResetAtMs } from './parse-openai-retry-after-reset-at-ms.js';
import { resolveOpenAiSdkBaseUrl } from './resolve-openai-sdk-base-url.js';

/**
 * Dispatches an OpenAI `/v1/responses` request through the official `openai` SDK client.
 *
 * Uses `maxRetries: 0` so HTTP `429` and `5xx` statuses return immediately with `resetAtMs` and raw error text.
 *
 * @param {OpenAiHttpRequest} request - Outbound OpenAI `/v1/responses` request envelope.
 *
 * @returns {Promise<OpenAiHttpResponse>} HTTP status, parsed JSON body or error text, and `resetAtMs`.
 *
 * @throws {Error} If `request.signal` is aborted or a non-`APIError` transport exception occurs.
 */
export async function sendOpenAiResponsesViaSdk(
  request: OpenAiHttpRequest,
): Promise<OpenAiHttpResponse> {
  request.signal?.throwIfAborted();
  const rawAuth = request.headers['authorization'];
  const bearerToken = rawAuth?.startsWith('Bearer ')
    ? rawAuth.slice('Bearer '.length)
    : rawAuth;
  const hasExplicitAuth = bearerToken !== undefined && bearerToken.length > 0;
  const client = new OpenAI({
    apiKey: hasExplicitAuth ? bearerToken : 'openai-seat-unconfigured',
    baseURL: resolveOpenAiSdkBaseUrl(request.url),
    maxRetries: 0,
    fetch: createOpenAiSdkFetch({
      hasExplicitAuth,
      baseFetch: request.fetch ?? globalThis.fetch,
    }),
  });
  try {
    const { data: responsePayload, response } = await client
      .post<Readonly<Record<string, unknown>>>('/responses', {
        body: request.body,
        headers: request.headers,
        signal: request.signal,
      })
      .withResponse();
    return Object.freeze<OpenAiHttpResponse>({
      status: response.status,
      body: responsePayload,
      bodyText: undefined,
      headers: undefined,
      resetAtMs: parseOpenAiRetryAfterResetAtMs(response.headers.get('retry-after')),
    });
  } catch (err: unknown) {
    if (err instanceof APIError) {
      const errBody =
        err.error !== undefined && err.error !== null && typeof err.error === 'object'
          ? (err.error as Readonly<Record<string, unknown>>)
          : Object.freeze({});
      return Object.freeze<OpenAiHttpResponse>({
        status: err.status ?? 500,
        body: errBody,
        bodyText: err.message,
        headers: undefined,
        resetAtMs: parseOpenAiRetryAfterResetAtMs(err.headers?.get('retry-after')),
      });
    }
    throw err;
  }
}
